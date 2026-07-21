// multisig.js
// マルチシグ設定 / マルチシグ送金 / マルチシグ署名(連署)
//
// マルチシグの設定変更・送金は「新しく追加される連署者の同意」や
// 「既存連署者の承認」が必要になるため、基本的に
//   ① アグリゲートボンデッドTxを自分の署名で作成
//   ② ハッシュロックTxで10XYMを一時的にロック(スパム防止の担保)
//   ③ ハッシュロックの承認を待つ
//   ④ /transactions/partial にボンデッドTxをアナウンス
// という流れで「提案」し、他の連署者は後から「マルチシグ署名」画面で
// 連署(cosign)して承認する、という設計にしている。

import { appState, getXymMosaicIdHex } from "./config.js";
import { signTxOnly, signAndAnnounceTx, cosignTransactionHash } from "./auth.js";
import { hexToBytes } from "./utils.js";

const HASH_LOCK_AMOUNT = 10_000_000n; // 10 XYM (microXYM)
const HASH_LOCK_DURATION = 480n; // 約4時間分のブロック数(目安)

/* ============================================================
   承認待ちポーリング(ハッシュロックの確定待ち)
============================================================ */
async function waitConfirmed(hash, { timeoutMs = 90000, intervalMs = 3000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${appState.NODE}/transactionStatus/${hash}`);
      if (res.ok) {
        const json = await res.json();
        if (json.group === "confirmed") return true;
        if (json.group === "failed") {
          throw new Error("ハッシュロックTxが失敗しました: " + (json.code ?? "unknown"));
        }
      }
    } catch (e) {
      console.warn("waitConfirmed polling error:", e);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("ハッシュロックの承認待ちがタイムアウトしました");
}

/* ============================================================
   アグリゲートボンデッドTxを作成・署名し、
   ハッシュロック → 承認待ち → /transactions/partial アナウンス
   まで一括で行う共通処理
============================================================ */
async function proposeBondedAggregate(embeddedTransactions, cosignerCount) {
  const { descriptors, models } = appState.sdkSymbol;

  const aggregateDescriptor = new descriptors.AggregateBondedTransactionV2Descriptor(
    appState.facade.static.hashEmbeddedTransactions(embeddedTransactions),
    embeddedTransactions
  );

  const aggregateTx = appState.facade.createTransactionFromTypedDescriptor(
    aggregateDescriptor,
    appState.currentPubKey,
    appState.feeMultiplier ?? 100,
    60 * 60 * 6, // 6時間
    cosignerCount
  );

  const { jsonPayload: aggregateJsonPayload, signedBytes } = await signTxOnly(aggregateTx);
  const signedAggregateTx = appState.facade.transactionFactory.static.deserialize(signedBytes);
  const aggregateHash = appState.facade.hashTransaction(signedAggregateTx);

  // ハッシュロックTx (10 XYMを一時ロック。連署が集まらず期限切れになると自動返却)
  const xymId = getXymMosaicIdHex();
  const hashLockDescriptor = new descriptors.HashLockTransactionV1Descriptor(
    new descriptors.UnresolvedMosaicDescriptor(
      new models.UnresolvedMosaicId(BigInt("0x" + xymId)),
      new models.Amount(HASH_LOCK_AMOUNT)
    ),
    new models.BlockDuration(HASH_LOCK_DURATION),
    aggregateHash
  );

  const hashLockTx = appState.facade.createTransactionFromTypedDescriptor(
    hashLockDescriptor,
    appState.currentPubKey,
    appState.feeMultiplier ?? 100,
    60 * 60
  );

  const hashLockTxHash = await signAndAnnounceTx(hashLockTx);

  await waitConfirmed(hashLockTxHash);

  // ハッシュロック確定後、ボンデッドTxを/transactions/partialへ
  const res = await fetch(new URL("/transactions/partial", appState.NODE), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: aggregateJsonPayload,
  });
  const result = await res.json();
  if (!res.ok) {
    throw new Error(result.message ?? "アグリゲートボンデッドTxのアナウンスに失敗しました");
  }

  return aggregateHash.toString();
}

/* ============================================================
   マルチシグ情報の取得
============================================================ */
export async function loadMultisigInfo() {
  const el = document.getElementById("multisig-info");
  if (!el) return;

  el.textContent = "読み込み中...";

  try {
    const address = appState.currentAddress.toString();
    const res = await fetch(`${appState.NODE}/account/${address}/multisig`);

    if (res.status === 404) {
      el.innerHTML = `<div style="color:#94a3b8;">このアカウントはまだマルチシグ化されていません</div>`;
      return;
    }

    const json = await res.json();
    const m = json.multisig;

    const cosignatoriesHtml = (m.cosignatoryAddresses || [])
      .map((a) => `<div>・${a}</div>`)
      .join("") || "<div>(なし)</div>";

    const multisigAddressesHtml = (m.multisigAddresses || [])
      .map((a) => `<div>・${a}</div>`)
      .join("") || "<div>(なし)</div>";

    el.innerHTML = `
      <div class="harvest-history-item">
        <div>最小承認者数(minApproval): ${m.minApproval}</div>
        <div>最小削除承認者数(minRemoval): ${m.minRemoval}</div>
        <div>連署者:</div>
        ${cosignatoriesHtml}
        <div>自分が連署者になっているマルチシグアカウント:</div>
        ${multisigAddressesHtml}
      </div>
    `;
  } catch (e) {
    console.error("loadMultisigInfo error:", e);
    el.textContent = "取得に失敗しました";
  }
}

/* ============================================================
   自分が連署者になっているマルチシグアカウント一覧(送金元選択用)
============================================================ */
export async function fetchCosignatoryOfAddresses() {
  const address = appState.currentAddress.toString();
  const res = await fetch(`${appState.NODE}/account/${address}/multisig`);
  if (res.status === 404) return [];
  const json = await res.json();
  return json.multisig?.multisigAddresses || [];
}

/* ============================================================
   マルチシグ設定(自分自身のアカウントを対象)
   追加する連署者は全員の同意(連署)が必要なため、常にボンデッドで提案する
============================================================ */
export async function updateMultisigSettings({
  minApprovalDelta,
  minRemovalDelta,
  additionAddresses,
  deletionAddresses,
}) {
  const { descriptors, models } = appState.sdkSymbol;

  const additions = additionAddresses.map((a) => new appState.sdkSymbol.Address(a));
  const deletions = deletionAddresses.map((a) => new appState.sdkSymbol.Address(a));

  const descriptor = new descriptors.MultisigAccountModificationTransactionV1Descriptor(
    minRemovalDelta,
    minApprovalDelta,
    additions,
    deletions
  );

  const embeddedTx = appState.facade.createEmbeddedTransactionFromTypedDescriptor(
    descriptor,
    appState.currentPubKey
  );

  // 新規追加する連署者の人数分だけ、追加の連署が必要
  const cosignerCount = additions.length;

  return await proposeBondedAggregate([embeddedTx], cosignerCount);
}

/* ============================================================
   マルチシグ送金
============================================================ */
export async function sendFromMultisig({ multisigAddress, recipientAddress, amountXym, message }) {
  const { descriptors, models } = appState.sdkSymbol;

  // 送金元(マルチシグアカウント)の公開鍵を取得
  const accountInfo = await fetch(new URL("/accounts/" + multisigAddress, appState.NODE)).then((r) =>
    r.json()
  );
  const multisigPublicKey = accountInfo.account?.publicKey;
  if (!multisigPublicKey || /^0+$/.test(multisigPublicKey)) {
    throw new Error("送金元アカウントの公開鍵が取得できません(未初期化アカウントの可能性があります)");
  }

  const xymId = getXymMosaicIdHex();
  const mosaics =
    amountXym > 0
      ? [
          new descriptors.UnresolvedMosaicDescriptor(
            new models.UnresolvedMosaicId(BigInt("0x" + xymId)),
            new models.Amount(BigInt(Math.floor(amountXym * 1_000_000)))
          ),
        ]
      : [];

  const messageBytes = new Uint8Array([0x00, ...new TextEncoder().encode(message || "")]);

  const transferDescriptor = new descriptors.TransferTransactionV1Descriptor(
    new appState.sdkSymbol.Address(recipientAddress),
    mosaics,
    messageBytes
  );

  const embeddedTx = appState.facade.createEmbeddedTransactionFromTypedDescriptor(
    transferDescriptor,
    new appState.sdkCore.PublicKey(multisigPublicKey)
  );

  // 自分自身の署名(起案者)がマルチシグの連署者の1人としてそのままカウントされるため、
  // ここでは追加の連署者数は指定しない(0)。承認数が足りない場合は他の連署者が
  // 「マルチシグ署名」から追加で連署する。
  return await proposeBondedAggregate([embeddedTx], 0);
}

/* ============================================================
   マルチシグ署名(保留中のアグリゲートボンデッドTx一覧・連署)
============================================================ */
export async function loadPendingPartialTransactions() {
  const el = document.getElementById("multisig-pending-list");
  if (!el) return;

  el.textContent = "読み込み中...";

  try {
    const address = appState.currentAddress.toString();
    const params = new URLSearchParams({ address, embedded: true, pageSize: 50 });
    const res = await fetch(`${appState.NODE}/transactions/partial?${params}`);
    const json = await res.json();
    const items = json.data ?? [];

    if (items.length === 0) {
      el.innerHTML = `<div style="color:#94a3b8;">署名待ちのトランザクションはありません</div>`;
      return;
    }

    el.innerHTML = items
      .map((item) => {
        const hash = item.meta.hash;
        const cosigCount = (item.transaction.cosignatures || []).length;
        const alreadySigned = (item.transaction.cosignatures || []).some(
          (c) => c.signerPublicKey?.toUpperCase() === appState.currentPubKey?.toUpperCase()
        );

        return `
          <div class="harvest-history-item">
            <div>Hash: ${hash}</div>
            <div>現在の連署数: ${cosigCount}</div>
            <div>${alreadySigned ? "✅ 署名済み" : ""}</div>
            ${
              alreadySigned
                ? ""
                : `<button class="account-hide-btn" data-action="cosign" data-hash="${hash}">署名する</button>`
            }
          </div>
        `;
      })
      .join("");
  } catch (e) {
    console.error("loadPendingPartialTransactions error:", e);
    el.textContent = "取得に失敗しました";
  }
}

export async function cosignPending(transactionHashHex) {
  const cosignature = cosignTransactionHash(transactionHashHex);

  const res = await fetch(new URL("/transactions/cosignature", appState.NODE), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cosignature),
  });

  const result = await res.json();
  if (!res.ok) {
    throw new Error(result.message ?? "連署のアナウンスに失敗しました");
  }
  return result;
}
