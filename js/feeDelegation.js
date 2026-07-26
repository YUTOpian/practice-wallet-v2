// feeDelegation.js
// 手数料代払い(スポンサーシップ)機能
//
// Symbolのアグリゲートボンデッドを使い、ハッシュロック費用とネットワーク手数料を
// 「オーナー」が代わりに負担する仕組み。
//
//   ① ユーザー: 送りたい内容(誰に・何を・いくら)を入力 → 署名なしのJSONを書き出す
//   ② オーナー: そのJSONを読み込み、内容を確認したうえで
//      アグリゲートボンデッドTxを構築・署名・ハッシュロック支払い・アナウンスする
//      (ハッシュロック代・ネットワーク手数料は全てオーナー負担)
//   ③ ユーザー: 自分宛のコサイン待ちTx一覧を確認し、コサインするだけで送金が完了する
//
// このアプリはサーバーを持たない静的サイトのため、①→②の「依頼の受け渡し」は
// オフライントランザクション機能(offline.js)と同じ発想で、JSONファイルの
// やり取り(チャット・メール・QRコードなど任意の手段)で行う想定。
//
// ③のコサイン自体は multisig.js の「マルチシグ署名」と全く同じ仕組み
// (/transactions/partial の確認 + /transactions/cosignature へのアナウンス)
// なので、その関数(loadPendingPartialTransactions / cosignPending)を
// そのまま流用できる。

import { appState, NetworkType } from "./config.js";
import { proposeBondedAggregate } from "./multisig.js";

export const FEE_DELEGATION_REQUEST_TYPE = "KASANE_FEE_DELEGATION_REQUEST";
export const FEE_DELEGATION_REQUEST_VERSION = 1;

/* ============================================================
   ① ユーザー側: 送金依頼(署名なし)を作成する
   ネットワーク通信・秘密鍵は一切使わない(依頼内容を組み立てるだけ)。
============================================================ */
export function createSponsorshipRequest({ recipientAddress, mosaicIdHex, amount, message }) {
  if (!appState.currentAddress || !appState.currentPubKey) {
    throw new Error("アカウントが未接続です。");
  }
  if (!recipientAddress) {
    throw new Error("送信先アドレスを入力してください。");
  }
  if (!mosaicIdHex) {
    throw new Error("モザイクを選択してください。");
  }

  const mosaicIdUpper = mosaicIdHex.toUpperCase();
  const mosaicInfo = appState.mosaicInfo?.[mosaicIdUpper];
  const divisibility = mosaicInfo?.divisibility ?? 0;
  const amountNum = Number(amount);

  if (!Number.isFinite(amountNum) || amountNum < 0) {
    throw new Error("数量が不正です。");
  }

  const amountAtomic = BigInt(Math.round(amountNum * 10 ** divisibility));

  return {
    type: FEE_DELEGATION_REQUEST_TYPE,
    version: FEE_DELEGATION_REQUEST_VERSION,
    chain: "Symbol",
    network: appState.networkType === NetworkType.TESTNET ? "TEST_NET" : "MAIN_NET",
    requesterAddress: appState.currentAddress.toString(),
    requesterPublicKey: appState.currentPubKey,
    recipientAddress,
    mosaicId: mosaicIdUpper,
    mosaicName: mosaicInfo?.mosaicName ?? mosaicIdUpper,
    divisibility,
    amountDisplay: amountNum,
    amountAtomic: amountAtomic.toString(),
    message: message || "",
    createdAt: new Date().toISOString(),
  };
}

/* ============================================================
   JSONファイルとしてダウンロードさせる(offline.jsと同じ作法)
============================================================ */
export function downloadSponsorshipRequestJson(requestObject) {
  const blob = new Blob([JSON.stringify(requestObject, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `sponsor-request-${(requestObject.requesterAddress || "unknown").slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ============================================================
   ② オーナー側: JSONの形式検証
============================================================ */
export function parseSponsorshipRequestJson(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("JSONの形式が正しくありません。");
  }

  if (json.type !== FEE_DELEGATION_REQUEST_TYPE) {
    throw new Error(`対応していないファイル形式です(type: ${json.type ?? "不明"})。`);
  }
  if (!json.requesterAddress || !json.requesterPublicKey || !json.recipientAddress || !json.mosaicId) {
    throw new Error("依頼内容が不足しています。");
  }
  if (json.network !== "MAIN_NET" && json.network !== "TEST_NET") {
    throw new Error("networkの値が不正です。");
  }

  const expectedNetwork = appState.networkType === NetworkType.TESTNET ? "TEST_NET" : "MAIN_NET";
  if (json.network !== expectedNetwork) {
    throw new Error("現在接続中のネットワークと依頼のネットワークが一致しません。");
  }

  return json;
}

/* ============================================================
   ② オーナー側: 依頼を承認し、アグリゲートボンデッドTxを構築・署名・
   ハッシュロック支払い・アナウンスする(すべての手数料はオーナー負担)。
   ユーザーは埋め込みTransferの署名者になっているだけなので、
   ③でユーザー自身のコサインが揃って初めて送金が実行される。
============================================================ */
export async function approveSponsorshipRequest(request) {
  const { descriptors, models } = appState.sdkSymbol;

  const requesterPublicKey = new appState.sdkCore.PublicKey(request.requesterPublicKey);

  const mosaics =
    BigInt(request.amountAtomic) > 0n
      ? [
          new descriptors.UnresolvedMosaicDescriptor(
            new models.UnresolvedMosaicId(BigInt("0x" + request.mosaicId.toUpperCase())),
            new models.Amount(BigInt(request.amountAtomic))
          ),
        ]
      : [];

  const messageBytes = new Uint8Array([0x00, ...new TextEncoder().encode(request.message || "")]);

  const transferDescriptor = new descriptors.TransferTransactionV1Descriptor(
    new appState.sdkSymbol.Address(request.recipientAddress),
    mosaics,
    messageBytes
  );

  // 埋め込みTxの署名者は「依頼者(ユーザー)」自身。オーナーは初提案者として
  // アグリゲート全体の手数料とハッシュロックを負担するだけで、
  // この送金自体の当事者にはならない。
  const embeddedTx = appState.facade.createEmbeddedTransactionFromTypedDescriptor(
    transferDescriptor,
    requesterPublicKey
  );

  // 依頼者(ユーザー)本人のコサインが1件必要
  return await proposeBondedAggregate([embeddedTx], 1, {
    typeLabel: "手数料代払い(送金代行)",
    sender: request.requesterAddress,
    recipient: request.recipientAddress,
    details: [
      { label: "依頼者", value: request.requesterAddress },
      { label: "モザイク", value: `${request.mosaicName ?? request.mosaicId} (${request.mosaicId})` },
      { label: "数量", value: request.amountDisplay },
      { label: "メッセージ", value: request.message || "(なし)" },
      { label: "手数料負担", value: "このアカウント(オーナー)がハッシュロック・ネットワーク手数料を負担します" },
    ],
  });
}
