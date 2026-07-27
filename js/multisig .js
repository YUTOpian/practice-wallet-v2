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
import { signTxOnly, signAndAnnounceTx, cosignTransactionHash, estimateFeeFromTx } from "./auth.js";
import { hexToBytes, escapeHtml } from "./utils.js";
import { requestTxConfirmation, formatTxDeadline, TxCancelledError } from "./txConfirm.js";
import { decodeMessage, formatAddress } from "./transactions.js";

// REST APIが返す埋め込みトランザクションのtype値(数値)
const EMBEDDED_TX_TYPE = {
  TRANSFER: 16724,
  MULTISIG_ACCOUNT_MODIFICATION: 16725,
};

/* ============================================================
   埋め込みトランザクション1件を、連署前に人間が確認できる文言に変換する。

   ⚠️ 「マルチシグ連署」は、他人(オーナー/提案者)が作った内容に
   自分の署名を追加する行為なので、署名する前に「実際に何を承認する
   ことになるのか」(送金先・数量・メッセージ)を必ず表示する必要がある。
   以前はハッシュ値だけを見せて署名させていた(内容が一切確認できない
   「ブラインド署名」になっていた)。
============================================================ */
function describeEmbeddedTransaction(tx) {
  const type = Number(tx.type);

  if (type === EMBEDDED_TX_TYPE.TRANSFER) {
    const recipient = formatAddress(tx.recipientAddress);
    const xymId = getXymMosaicIdHex();

    const mosaicsText = (tx.mosaics || [])
      .map((m) => {
        const idHex = String(m.id ?? "").toUpperCase();
        if (idHex === xymId) {
          const xym = (Number(m.amount) / 1_000_000).toLocaleString("ja-JP", { maximumFractionDigits: 6 });
          return `${xym} XYM`;
        }
        return `${m.amount}（モザイクID: ${idHex}、可分性不明のため未換算の生数量）`;
      })
      .join(", ") || "(モザイクなし)";

    const message = decodeMessage(tx.message);
    return `送金 → 宛先: ${recipient} / 数量: ${mosaicsText} / メッセージ: ${message}`;
  }

  if (type === EMBEDDED_TX_TYPE.MULTISIG_ACCOUNT_MODIFICATION) {
    const additions = tx.addressAdditions ?? [];
    const deletions = tx.addressDeletions ?? [];
    return (
      `マルチシグ設定変更 → 最小承認者数の増減: ${tx.minApprovalDelta ?? 0} / ` +
      `最小削除承認者数の増減: ${tx.minRemovalDelta ?? 0} / ` +
      `追加: ${additions.length ? additions.map(formatAddress).join(", ") : "(なし)"} / ` +
      `削除: ${deletions.length ? deletions.map(formatAddress).join(", ") : "(なし)"}`
    );
  }

  // 未対応の種類は種別コードだけでも必ず表示する(内容を隠さない)
  return `その他のトランザクション（type: ${tx.type}）。この画面では内容を要約表示できません。署名前に内容を把握できているか十分ご注意ください。`;
}

function describeEmbeddedTransactions(embedded) {
  return (embedded || []).map((item) => describeEmbeddedTransaction(item.transaction ?? item));
}

/* ============================================================
   連署の実効性チェック:
   埋め込みトランザクションの signerPublicKey(＝送金元として必要な
   署名者)と、いま実際に連署しようとしている自分のアカウントの公開鍵が
   一致しているかを確認する。

   ⚠️ 「連署パケット自体はノードに正しく記録されるが、実際には送金元の
   要件を満たしていない」というケースは、エラーが一切出ないまま
   Txが永遠に partial(未確定)のまま残る、という分かりにくい不具合を
   引き起こす。これを未然に警告できるようにする。

   ただし、送金元がマルチシグアカウントの場合はsignerPublicKeyが
   マルチシグアカウント自身の鍵になり、実際に連署すべきなのは
   その"連署者"(cosignatory)なので、単純な不一致だけでは
   「間違ったアカウント」と断定できない。そのため警告文でも
   マルチシグの可能性には触れる形にする。
============================================================ */
function checkSignerMismatch(embedded) {
  const requiredSigners = [
    ...new Set(
      (embedded || [])
        .map((item) => (item.transaction ?? item).signerPublicKey)
        .filter(Boolean)
        .map((pk) => pk.toUpperCase())
    ),
  ];

  const myPubKeyUpper = (appState.currentPubKey || "").toUpperCase();
  const matches = requiredSigners.length === 0 || requiredSigners.includes(myPubKeyUpper);

  return { requiredSigners, matches };
}

const HASH_LOCK_AMOUNT = 10_000_000n; // 10 XYM (microXYM)

/* ============================================================
   ハッシュロックの承認待ちが「タイムアウト」した場合専用のエラー。
   (ネットワーク混雑等で実際にはこの後ハッシュロック自体は確定する
   可能性があるため、「失敗」と区別して呼び出し側でリカバリー情報を
   案内できるようにする)
============================================================ */
export class HashLockTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "HashLockTimeoutError";
  }
}

// アグリゲートボンデッドTx本体の有効期限(秒)。proposeBondedAggregate内の
// createTransactionFromTypedDescriptor() 呼び出しと必ず同じ値を使うこと。
const AGGREGATE_BONDED_DEADLINE_SECONDS = 60 * 60 * 6; // 6時間

// ブロック生成間隔(秒)。メインネット/テストネットともに30秒。
const BLOCK_TARGET_SECONDS = 30;

// ハッシュロックの有効期間(ブロック数)。
// ★ここは必ずアグリゲート本体の有効期限(AGGREGATE_BONDED_DEADLINE_SECONDS)より
//   長くすること。短いと、有効期限ぎりぎりで連署が集まった際に
//   ハッシュロックの担保が先に失効・返却されてしまい、アグリゲートTxが
//   確定できずに送金が失敗する(連署者からは「見えていたのに送れなかった」
//   ように見えるバグの原因になる)。念のため1時間分の余裕を持たせる。
const HASH_LOCK_DURATION = BigInt(
  Math.ceil(AGGREGATE_BONDED_DEADLINE_SECONDS / BLOCK_TARGET_SECONDS) + Math.ceil(3600 / BLOCK_TARGET_SECONDS)
); // 6時間 + 1時間の余裕 ≒ 840ブロック

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
  throw new HashLockTimeoutError("ハッシュロックの承認待ちがタイムアウトしました");
}

/* ============================================================
   署名済みのアグリゲートボンデッドTxを /transactions/partial へ
   アナウンスする。proposeBondedAggregate 本体からも、ハッシュロックの
   承認待ちがタイムアウトした後の手動リトライからも使える共通処理。
============================================================ */
export async function announcePartialAggregate(aggregateJsonPayload) {
  const res = await fetch(new URL("/transactions/partial", appState.NODE), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: aggregateJsonPayload,
  });
  const result = await res.json();
  if (!res.ok) {
    throw new Error(result.message ?? "アグリゲートボンデッドTxのアナウンスに失敗しました");
  }
  return result;
}

/* ============================================================
   アグリゲートボンデッドTxを作成・署名し、
   ハッシュロック → 承認待ち → /transactions/partial アナウンス
   まで一括で行う共通処理
============================================================ */
export async function proposeBondedAggregate(embeddedTransactions, cosignerCount, confirmInfo) {
  const { descriptors, models } = appState.sdkSymbol;

  const aggregateDescriptor = new descriptors.AggregateBondedTransactionV3Descriptor(
    appState.facade.static.hashEmbeddedTransactions(embeddedTransactions),
    embeddedTransactions
  );

  const aggregateTx = appState.facade.createTransactionFromTypedDescriptor(
    aggregateDescriptor,
    appState.currentPubKey,
    appState.feeMultiplier ?? 100,
    AGGREGATE_BONDED_DEADLINE_SECONDS,
    cosignerCount
  );

  // マルチシグの提案内容そのものの確認(実際の担保としてハッシュロックで10XYMが
  // 一時的にロックされることも合わせて表示する)
  if (confirmInfo) {
    const confirmed = await requestTxConfirmation({
      typeLabel: confirmInfo.typeLabel,
      sender: confirmInfo.sender,
      recipient: confirmInfo.recipient,
      fee: estimateFeeFromTx(aggregateTx),
      deadlineText: formatTxDeadline(aggregateTx),
      details: [
        ...(confirmInfo.details ?? []),
        { label: "必要な追加連署者数", value: cosignerCount },
        { label: "担保(ハッシュロック)", value: "10 XYM（承認完了、または期限切れで返却されます）" },
      ],
    });
    if (!confirmed) {
      throw new TxCancelledError();
    }
  }

  const { jsonPayload: aggregateJsonPayload, signedBytes } = await signTxOnly(aggregateTx);
  const signedAggregateTx = appState.facade.transactionFactory.static.deserialize(signedBytes);
  const aggregateHash = appState.facade.hashTransaction(signedAggregateTx);

  // SSS Extensionでは、直前の署名ポップアップを閉じた直後に次のポップアップを
  // 開こうとすると、表示が間に合わず一瞬で消えてしまうことがある
  // (transfer.jsのメッセージ暗号化時と同じ問題)。
  // ここではアグリゲート本体の署名(ポップアップ①)の直後に
  // ハッシュロックTxの署名(ポップアップ②)をリクエストするため、
  // ローカル署名(ニーモニック/秘密鍵)以外の場合は少し間隔を空ける。
  if (appState.authMode !== "local") {
    await new Promise((r) => setTimeout(r, 600));
  }

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

  try {
    await waitConfirmed(hashLockTxHash);
  } catch (e) {
    if (e instanceof HashLockTimeoutError) {
      // ⚠️ ここで例外を投げてaggregateJsonPayloadを握りつぶすと、
      // ハッシュロック自体は後から確定してしまい(ネットワーク混雑で
      // 単に90秒以内に承認が確認できなかっただけの可能性がある)、
      // 誰にも使われないまま10XYMがHASH_LOCK_DURATION(約7時間)分
      // ロックされ続けるだけになってしまう。
      // 署名済みペイロードをコンソールに残し、ハッシュロックが実際には
      // 確定していた場合に手動で再アナウンスできるようにしておく。
      console.warn(
        "[multisig] ハッシュロックの承認待ちがタイムアウトしました。" +
        "ハッシュロック自体は後から確定する可能性があります。もし確定していた場合、" +
        "以下のペイロードを announcePartialAggregate(aggregateJsonPayload) " +
        "(multisig.jsからexport済み)に渡せば提案を送信し直せます。",
        { hashLockTxHash, aggregateJsonPayload }
      );
      throw new HashLockTimeoutError(
        `ハッシュロックの承認待ちがタイムアウトしました(Hash: ${hashLockTxHash})。` +
        "ハッシュロック自体は後から確定する可能性があります。少し待ってから" +
        "もう一度提案するか、ブラウザのコンソールに出力された復旧手順で再送信してください。"
      );
    }
    throw e;
  }

  // ハッシュロック確定後、ボンデッドTxを/transactions/partialへ
  await announcePartialAggregate(aggregateJsonPayload);

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

  return await proposeBondedAggregate([embeddedTx], cosignerCount, {
    typeLabel: "マルチシグ設定変更",
    details: [
      { label: "最小承認者数の増減", value: minApprovalDelta },
      { label: "最小削除承認者数の増減", value: minRemovalDelta },
      { label: "追加する連署者", value: additionAddresses.length ? additionAddresses.join(", ") : "(なし)" },
      { label: "削除する連署者", value: deletionAddresses.length ? deletionAddresses.join(", ") : "(なし)" },
    ],
  });
}

/* ============================================================
   対象マルチシグアカウントの minApproval を取得する
   (sendFromMultisig で、必要な追加連署者数を正しく見積もるために使う)
============================================================ */
async function fetchMultisigMinApproval(address) {
  try {
    const res = await fetch(`${appState.NODE}/account/${address}/multisig`);
    if (res.status === 404) return null;
    const json = await res.json();
    const minApproval = Number(json.multisig?.minApproval);
    return Number.isFinite(minApproval) ? minApproval : null;
  } catch (e) {
    console.warn("fetchMultisigMinApproval error:", address, e);
    return null;
  }
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

  // ⚠️ 以前は常に 0 を渡していたが、それが正しいのは対象マルチシグの
  // minApproval が 1 の場合のみだった。起案者自身の署名がそのまま
  // 1人分の連署としてカウントされるので、必要な「追加」連署者数は
  // (minApproval - 1)。minApproval が取得できない場合は
  // 安全側(0)にフォールバックする。
  const minApproval = await fetchMultisigMinApproval(multisigAddress);
  const cosignerCount = minApproval != null ? Math.max(0, minApproval - 1) : 0;

  return await proposeBondedAggregate([embeddedTx], cosignerCount, {
    typeLabel: "マルチシグ送金(提案)",
    sender: multisigAddress,
    recipient: recipientAddress,
    details: [
      { label: "数量", value: `${amountXym} XYM` },
      { label: "メッセージ", value: message || "(なし)" },
      ...(minApproval != null
        ? [{ label: "必要な承認数(minApproval)", value: `${minApproval}(うち自分の署名で1件済み)` }]
        : []),
    ],
  });
}

/* ============================================================
   マルチシグ署名(保留中のアグリゲートボンデッドTx一覧・連署)

   ⚠ アグリゲートボンデッドTxは、アナウンスされたノードのローカルな
   「partial」キャッシュに載るだけで、他ノードへの伝播にはP2P同期の
   時間差がある(伝播しないケースもある)。そのため、連署する側が
   アナウンスした側と別のノードに接続していると、この一覧に
   何も表示されないことがある。これを補うため、相手から渡された
   「コサイン情報」(ハッシュ＋アナウンス先ノード)がある場合は、
   そのノードへ直接ハッシュ指定で問い合わせて表示する
   (externalHash 引数、feeDelegation.js から利用)。
============================================================ */

// 1件分のカードHTML(一覧表示・直接取得表示の両方で共通利用)
function renderPendingItemHtml(hash, transaction, nodeUrl) {
  const cosigCount = (transaction.cosignatures || []).length;
  const alreadySigned = (transaction.cosignatures || []).some(
    (c) => c.signerPublicKey?.toUpperCase() === appState.currentPubKey?.toUpperCase()
  );

  // ⚠️ 「署名する」ボタンを押すまで中身(送金先・数量・メッセージ等)が
  // 全く分からないブラインド署名になってしまうため、一覧の時点でも要約を表示する。
  const contentHtml = describeEmbeddedTransactions(transaction.transactions)
    .map((desc) => `<div>内容: ${escapeHtml(desc)}</div>`)
    .join("");

  // ⚠️ 連署パケット自体はノードに正しく記録されるが、実際には自分の
  // アカウントが必要な署名者ではないため、いつまでも確定しない
  // ケースがあるため、一覧の時点でも気づけるよう警告を出す。
  const signerCheck = checkSignerMismatch(transaction.transactions);
  const signerWarningHtml =
    !alreadySigned && !signerCheck.matches
      ? `<div style="color:#f97316;">⚠️ 現在ログイン中のアカウントは、この提案の署名者と一致していない可能性があります(送金元がマルチシグアカウントの場合は問題ありません)</div>`
      : "";

  return `
    <div class="harvest-history-item">
      <div>Hash: ${escapeHtml(hash)}</div>
      ${contentHtml}
      <div>現在の連署数: ${cosigCount}</div>
      ${signerWarningHtml}
      <div>${alreadySigned ? "✅ 署名済み" : ""}</div>
      ${
        alreadySigned
          ? ""
          : `<button class="account-hide-btn" data-action="cosign" data-hash="${escapeHtml(hash)}" data-node="${escapeHtml(nodeUrl ?? "")}">署名する</button>`
      }
    </div>
  `;
}

/* ============================================================
   指定ノードから、指定ハッシュの連署待ち(partial)Txを1件だけ直接取得する。
   アドレス検索(loadPendingPartialTransactions)に頼らないため、
   そのノードのキャッシュに載ってさえいれば、自分の接続ノードとは
   無関係に見つけられる。
============================================================ */
export async function fetchPartialTransactionByHash(nodeUrl, hash) {
  if (!nodeUrl || !hash) return null;
  try {
    const res = await fetch(`${nodeUrl}/transactions/partial/${hash}`);
    if (!res.ok) return null;
    const json = await res.json();
    return json?.transaction ? json : null;
  } catch (e) {
    console.warn("fetchPartialTransactionByHash error:", nodeUrl, e);
    return null;
  }
}

/* ============================================================
   externalHash: { hash, node } を渡すと、通常のアドレス検索結果に
   含まれていなかった場合のみ、そのノードへ直接問い合わせて追加表示する。
============================================================ */
export async function loadPendingPartialTransactions(elId = "multisig-pending-list", externalHash = null) {
  const el = document.getElementById(elId);
  if (!el) return;

  el.textContent = "読み込み中...";

  try {
    const address = appState.currentAddress.toString();
    const params = new URLSearchParams({ address, embedded: true, pageSize: 50 });
    const res = await fetch(`${appState.NODE}/transactions/partial?${params}`);
    const json = await res.json();
    const items = json.data ?? [];

    let externalHtml = "";
    if (externalHash?.hash) {
      const alreadyListed = items.some(
        (item) => item.meta?.hash?.toUpperCase() === externalHash.hash.toUpperCase()
      );
      if (!alreadyListed) {
        const targetNode = externalHash.node || appState.NODE;
        const found = await fetchPartialTransactionByHash(targetNode, externalHash.hash);
        if (found?.transaction) {
          externalHtml =
            `<div style="color:#facc15;font-size:12px;">🔎 指定ノード(${targetNode})から直接見つかりました(自分の接続ノードにはまだ反映されていない可能性があります)</div>` +
            renderPendingItemHtml(externalHash.hash, found.transaction, targetNode);
        }
      }
    }

    if (items.length === 0 && !externalHtml) {
      el.innerHTML = `<div style="color:#94a3b8;">署名待ちのトランザクションはありません</div>`;
      return;
    }

    const listHtml = items
      .map((item) => renderPendingItemHtml(item.meta.hash, item.transaction, appState.NODE))
      .join("");

    el.innerHTML = externalHtml + listHtml;
  } catch (e) {
    console.error("loadPendingPartialTransactions error:", e);
    el.textContent = "取得に失敗しました";
  }
}

/* ============================================================
   nodeUrlOverride を指定すると、そのノードへ直接コサインをアナウンスする
   (相手から伝えられた「アナウンス先ノード」に確実に届けるため)。
   省略時は従来通り自分の接続中ノード(appState.NODE)を使う。
============================================================ */
/* ============================================================
   連署(コサイン)パケットを1ノードへPUTする。
   レスポンスが200でも「そのノードが受理して転送した」という
   意味でしかなく、実際に反映された保証ではない。
============================================================ */
async function announceCosignature(nodeUrl, cosignature) {
  const res = await fetch(new URL("/transactions/cosignature", nodeUrl), {
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

/* ============================================================
   短時間だけトランザクションの状態をポーリングして確認する。
   (連署の送信が成功しても、実際に確定したかどうかは別問題であり、
   これを確認せずに「完了しました」と表示していたのが実害のある不具合
   だったため、必ずここで確認してから呼び出し側へ結果を返す)
============================================================ */
async function pollTransactionStatus(nodeUrl, hash, { attempts = 6, intervalMs = 2000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${nodeUrl}/transactionStatus/${hash}`);
      if (res.ok) {
        const json = await res.json();
        if (json.group === "confirmed" || json.group === "failed") {
          return json;
        }
      }
    } catch {
      // ネットワークエラーは無視して次のポーリングへ
    }
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  return null; // まだ確定していない(要:後で改めて確認)
}

export async function cosignPending(transactionHashHex, nodeUrlOverride = null) {
  const nodeUrl = nodeUrlOverride || appState.NODE;

  // ⚠️ 以前はハッシュ値だけを見せて連署するかどうかを聞いていた
  // (＝実際に何を承認することになるのか、ここでは一切確認できなかった)。
  // 連署は他人が作った内容を承認する行為なので、署名前に必ず
  // 対象の保留中トランザクションを取得し、内容を確認できるようにする。
  const found = await fetchPartialTransactionByHash(nodeUrl, transactionHashHex);
  const embeddedDescriptions = found?.transaction
    ? describeEmbeddedTransactions(found.transaction.transactions)
    : null;

  const deadlineText = found?.transaction ? formatTxDeadline(found.transaction) : null;
  const deadlineMs = (() => {
    try {
      const raw = found?.transaction?.deadline;
      if (raw == null || !appState.epochAdjustment) return null;
      return Number(appState.epochAdjustment) * 1000 + Number(raw);
    } catch {
      return null;
    }
  })();
  const isExpired = deadlineMs != null && Date.now() > deadlineMs;

  const signerCheck = found?.transaction
    ? checkSignerMismatch(found.transaction.transactions)
    : { requiredSigners: [], matches: true };

  const confirmed = await requestTxConfirmation({
    typeLabel: "マルチシグ連署(承認)",
    details: [
      { label: "対象トランザクションHash", value: transactionHashHex },
      ...(nodeUrlOverride ? [{ label: "アナウンス先ノード", value: nodeUrl }] : []),
      ...(deadlineText ? [{ label: "有効期限", value: deadlineText }] : []),
      ...(isExpired
        ? [{ label: "⚠️ 期限切れの可能性", value: "有効期限を過ぎています。連署しても反映されない可能性が高いです。" }]
        : []),
      ...(!signerCheck.matches
        ? [
            {
              label: "⚠️ 署名者が一致しない可能性",
              value:
                `この提案の送金元として必要な公開鍵(${signerCheck.requiredSigners.join(", ")})と、` +
                `現在ログイン中のアカウントの公開鍵(${appState.currentPubKey ?? "---"})が一致しません。` +
                "送金元がマルチシグアカウント自身であれば連署者の1人として問題ない場合がありますが、" +
                "そうでない場合、連署はノードに記録されても要件を満たさず、" +
                "いつまでも承認されずに残り続けます(エラーは出ません)。ログイン中のアカウントが正しいか確認してください。",
            },
          ]
        : []),
      ...(embeddedDescriptions && embeddedDescriptions.length
        ? embeddedDescriptions.map((desc, i) => ({ label: `内容 ${i + 1}`, value: desc }))
        : [
            {
              label: "⚠️ 内容確認",
              value: "対象トランザクションの内容を取得できませんでした。中身を確認せずに署名することになりますが、よろしいですか？",
            },
          ]),
    ],
  });
  if (!confirmed) {
    throw new TxCancelledError();
  }

  const cosignature = cosignTransactionHash(transactionHashHex);

  // ⚠️ 「アグリゲートTxが実際にアナウンスされているノード」と、いま連署を
  // 送ろうとしているノードが食い違っていると、そのノードは連署パケットを
  // 「受け取って転送した」と200を返しつつも、紐付ける親のアグリゲートを
  // ローカルに持っていないため実質的に反映されないことがある。
  // これを避けるため、対象ノード(nodeUrl)に加えて、自分が現在接続中の
  // ノード(appState.NODE)が別であればそちらにも送っておく。
  const targetNodes = [...new Set([nodeUrl, appState.NODE].filter(Boolean))];
  const announceResults = [];
  for (const target of targetNodes) {
    try {
      announceResults.push(await announceCosignature(target, cosignature));
    } catch (e) {
      console.warn(`[multisig] 連署のアナウンスに失敗しました(${target}):`, e);
    }
  }
  if (announceResults.length === 0) {
    throw new Error("連署のアナウンスにすべてのノードで失敗しました。");
  }

  // 送信して終わりにせず、実際にどうなったかを短時間だけ確認する
  const statusResult = await pollTransactionStatus(nodeUrl, transactionHashHex);

  return {
    ...announceResults[0],
    announcedTo: targetNodes,
    finalStatus: statusResult?.group ?? "unknown", // "confirmed" | "failed" | "unknown"
    finalStatusDetail: statusResult ?? null,
  };
}
