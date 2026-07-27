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

import { appState, NetworkType, getXymMosaicIdHex } from "./config.js";
import { proposeBondedAggregate } from "./multisig.js";

export const FEE_DELEGATION_REQUEST_TYPE = "KASANE_FEE_DELEGATION_REQUEST";
export const FEE_DELEGATION_REQUEST_VERSION = 1;

// 依頼(JSON)の有効期限。オーナーが古い依頼を状況が変わった後に
// 気づかず承認してしまうことを防ぐため、発行から一定時間で無効化する。
const REQUEST_VALIDITY_MS = 24 * 60 * 60 * 1000; // 24時間

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

  // ⚠️ 数量欄が空欄の場合 Number("") は 0 になり、以前はそのまま
  // 「モザイクなし(メッセージのみ)」の依頼として黙って通ってしまっていた。
  // オーナー側にハッシュロック+承認待ちの手間をかけさせる機能なので、
  // 入力ミスは明示的にエラーとして弾く。
  const amountRaw = (amount ?? "").toString().trim();
  let amountNum = 0;
  if (amountRaw !== "") {
    amountNum = Number(amountRaw);
    if (!Number.isFinite(amountNum) || amountNum < 0) {
      throw new Error("数量が不正です。");
    }
  }
  if (amountNum === 0 && (!message || message.trim() === "")) {
    throw new Error("数量またはメッセージのいずれかを入力してください。");
  }

  const amountAtomic = BigInt(Math.round(amountNum * 10 ** divisibility));
  const createdAt = new Date();

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
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + REQUEST_VALIDITY_MS).toISOString(),
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

  // 有効期限チェック(旧形式のexpiresAtを持たない依頼はチェックをスキップする)
  if (json.expiresAt) {
    const expiresAtMs = new Date(json.expiresAt).getTime();
    if (Number.isFinite(expiresAtMs) && Date.now() > expiresAtMs) {
      throw new Error(
        `この依頼は有効期限(${json.expiresAt})を過ぎています。依頼者に依頼を作り直してもらってください。`
      );
    }
  }

  return json;
}

/* ============================================================
   ② オーナー側: 承認・アナウンス後に依頼者(ユーザー)へ返す「コサイン情報」

   アグリゲートボンデッドTxは、アナウンスしたノードのローカルキャッシュに
   載るだけで、他ノードへの伝播にはP2P同期の時間差がある(伝播しない
   こともある)。ユーザーがオーナーと別のノードに接続していると、
   「支払い状況」タブのアドレス検索だけでは見つからず、連署できないまま
   ハッシュロック・アグリゲート双方が期限切れになってしまう。
   これを避けるため、実際にアナウンスしたノードとアグリゲートハッシュを
   ここでファイル化し、依頼JSONと同じ要領でユーザーへ渡せるようにする。
============================================================ */
export const FEE_DELEGATION_COSIGN_INFO_TYPE = "KASANE_FEE_DELEGATION_COSIGN_INFO";
export const FEE_DELEGATION_COSIGN_INFO_VERSION = 1;

export function buildCosignInfo(request, aggregateHash) {
  return {
    type: FEE_DELEGATION_COSIGN_INFO_TYPE,
    version: FEE_DELEGATION_COSIGN_INFO_VERSION,
    chain: "Symbol",
    network: request.network,
    aggregateHash,
    node: appState.NODE,
    requesterAddress: request.requesterAddress,
    recipientAddress: request.recipientAddress,
    mosaicId: request.mosaicId,
    mosaicName: request.mosaicName,
    amountDisplay: request.amountDisplay,
    createdAt: new Date().toISOString(),
  };
}

export function downloadCosignInfoJson(cosignInfoObject) {
  const blob = new Blob([JSON.stringify(cosignInfoObject, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cosign-info-${(cosignInfoObject.aggregateHash || "unknown").slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ============================================================
   ③ ユーザー側: オーナーから受け取った「コサイン情報」JSONの形式検証
============================================================ */
export function parseCosignInfoJson(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("JSONの形式が正しくありません。");
  }

  if (json.type !== FEE_DELEGATION_COSIGN_INFO_TYPE) {
    throw new Error(`対応していないファイル形式です(type: ${json.type ?? "不明"})。`);
  }
  if (!json.aggregateHash || !json.node) {
    throw new Error("コサイン情報が不足しています(aggregateHash / node が必要です)。");
  }
  if (json.network !== "MAIN_NET" && json.network !== "TEST_NET") {
    throw new Error("networkの値が不正です。");
  }

  const expectedNetwork = appState.networkType === NetworkType.TESTNET ? "TEST_NET" : "MAIN_NET";
  if (json.network !== expectedNetwork) {
    throw new Error("現在接続中のネットワークとファイルのネットワークが一致しません。");
  }

  return json;
}

/* ============================================================
   ② オーナー側: 依頼内容を、依頼者の自己申告に頼らず独立に検証する。

   ・requesterPublicKey から実際に導出されるアドレスと requesterAddress
     が一致するか(送金元は常に requesterPublicKey で決まるため、ここが
     ズレていると「表示」と「実際に動く署名者」が食い違う)
   ・依頼者の実際の残高が amountAtomic 以上あるか
   ・依頼者が申告した amountDisplay/divisibility が、ノードから取得した
     実際の divisibility から再計算した値と一致するか
     (amountAtomic は依頼者の自己申告 divisibility を前提に計算されて
     いるため、そこがズレていると「表示上は少額」に見えても実際には
     大きく異なる量が送られる可能性がある)

   ネットワークエラー等で確認できない項目は「警告」として返すだけで
   例外は投げない(呼び出し側で警告を見せた上で、承認するかどうかは
   オーナーの判断に委ねる)。
============================================================ */
export async function verifySponsorshipRequest(request) {
  const warnings = [];
  let recalculatedAmountDisplay = null;
  let actualDivisibility = null;

  // ① requesterPublicKey → address の整合性(ネットワーク不要)
  try {
    const pub = new appState.sdkCore.PublicKey(request.requesterPublicKey);
    const derivedAddress = appState.facade.createPublicAccount(pub).address.toString();
    if (derivedAddress !== request.requesterAddress) {
      warnings.push(
        `requesterAddress(${request.requesterAddress})が、requesterPublicKeyから導出される` +
        `アドレス(${derivedAddress})と一致しません。実際の送金元はrequesterPublicKey側です。`
      );
    }
  } catch {
    warnings.push("requesterPublicKeyの形式が不正で、アドレスとの整合性を確認できませんでした。");
  }

  // ② 依頼者の実際の残高確認
  try {
    const res = await fetch(new URL("/accounts/" + request.requesterAddress, appState.NODE));
    const accountJson = res.status === 404 ? null : await res.json();
    const mosaics = accountJson?.account?.mosaics ?? [];
    const requestedIdUpper = request.mosaicId.toUpperCase();
    const held = mosaics.find((m) => {
      const idHex = BigInt(m.id).toString(16).toUpperCase().padStart(16, "0");
      return idHex === requestedIdUpper;
    });
    const heldAmount = held ? BigInt(held.amount) : 0n;
    if (heldAmount < BigInt(request.amountAtomic)) {
      warnings.push(
        `依頼者の実際の残高(atomic: ${heldAmount})が、依頼数量(atomic: ${request.amountAtomic})に` +
        `足りていない可能性があります(承認しても実行できないことがあります)。`
      );
    }
  } catch {
    warnings.push("依頼者の残高確認に失敗しました(ノードエラー)。");
  }

  // ③ amountDisplay の独立検算(実際のdivisibilityを取得し直す)
  try {
    const xymId = getXymMosaicIdHex();
    if (request.mosaicId.toUpperCase() === xymId) {
      actualDivisibility = 6;
    } else {
      const mosaicRes = await fetch(new URL("/mosaics/" + request.mosaicId, appState.NODE)).then((r) => r.json());
      actualDivisibility = Number(mosaicRes.mosaic?.divisibility ?? 0);
    }
    recalculatedAmountDisplay = Number(request.amountAtomic) / 10 ** actualDivisibility;

    const displayNum = Number(request.amountDisplay);
    const tolerance = 10 ** -actualDivisibility / 2;
    if (!Number.isFinite(displayNum) || Math.abs(recalculatedAmountDisplay - displayNum) > tolerance) {
      warnings.push(
        `依頼者側の表示数量(${request.amountDisplay})と、実際のdivisibility(${actualDivisibility})から` +
        `再計算した数量(${recalculatedAmountDisplay})が一致しません。実際に送られるのは後者です。`
      );
    }
  } catch {
    warnings.push("モザイク情報の取得に失敗し、表示数量の検算ができませんでした。");
  }

  return { warnings, recalculatedAmountDisplay, actualDivisibility };
}

/* ============================================================
   同一依頼の重複承認防止

   依頼JSONを誤って2回読み込んで2回承認すると、内容が同じでも
   別々の提案(別ハッシュ・別ハッシュロック)として処理されてしまう。
   承認済みの依頼の「指紋」をlocalStorageに残しておき、再度同じ依頼を
   読み込んだ際に警告できるようにする(ブロックはしない。正当な理由で
   同じ依頼を再送する場合もあるため、最終判断はオーナーに委ねる)。
============================================================ */
const APPROVED_FINGERPRINTS_STORAGE_KEY = "feeDelegationApprovedFingerprints";
const MAX_STORED_FINGERPRINTS = 200;

function computeRequestFingerprint(request) {
  return [
    request.requesterAddress,
    request.requesterPublicKey,
    request.recipientAddress,
    request.mosaicId,
    request.amountAtomic,
    request.message || "",
    request.createdAt,
  ].join("|");
}

function loadApprovedFingerprints() {
  try {
    const raw = localStorage.getItem(APPROVED_FINGERPRINTS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function hasApprovedBefore(request) {
  const fingerprint = computeRequestFingerprint(request);
  return loadApprovedFingerprints().some((e) => e.fingerprint === fingerprint);
}

function recordApprovedFingerprint(request) {
  try {
    const list = loadApprovedFingerprints();
    list.push({ fingerprint: computeRequestFingerprint(request), approvedAt: new Date().toISOString() });
    localStorage.setItem(
      APPROVED_FINGERPRINTS_STORAGE_KEY,
      JSON.stringify(list.slice(-MAX_STORED_FINGERPRINTS))
    );
  } catch (e) {
    console.warn("recordApprovedFingerprint failed", e);
  }
}

/* ============================================================
   ② オーナー側: 依頼を承認し、アグリゲートボンデッドTxを構築・署名・
   ハッシュロック支払い・アナウンスする(すべての手数料はオーナー負担)。
   ユーザーは埋め込みTransferの署名者になっているだけなので、
   ③でユーザー自身のコサインが揃って初めて送金が実行される。

   verification: verifySponsorshipRequest() の戻り値(省略可)。
   渡された場合、確認画面に独立検算した数量・警告を表示する。
============================================================ */
export async function approveSponsorshipRequest(request, verification = null) {
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

  const isDuplicate = hasApprovedBefore(request);

  // ⚠️ ここで表示する「数量」は、依頼者の自己申告(amountDisplay)ではなく
  // verification.recalculatedAmountDisplay(実際のdivisibilityから
  // オーナー側で独立に再計算した値)を優先する。取得できなかった場合のみ
  // 自己申告値にフォールバックする。
  const amountLabel =
    verification?.recalculatedAmountDisplay != null
      ? `${verification.recalculatedAmountDisplay}（依頼者の自己申告: ${request.amountDisplay}）`
      : `${request.amountDisplay}（⚠️ 実際のdivisibilityで再検算できていません）`;

  // 依頼者(ユーザー)本人のコサインが1件必要
  return await proposeBondedAggregate([embeddedTx], 1, {
    typeLabel: "手数料代払い(送金代行)",
    sender: request.requesterAddress,
    recipient: request.recipientAddress,
    details: [
      { label: "依頼者", value: request.requesterAddress },
      { label: "モザイク", value: `${request.mosaicName ?? request.mosaicId} (${request.mosaicId})` },
      { label: "数量(オーナー側で再検算)", value: amountLabel },
      { label: "メッセージ", value: request.message || "(なし)" },
      { label: "手数料負担", value: "このアカウント(オーナー)がハッシュロック・ネットワーク手数料を負担します" },
      ...(isDuplicate
        ? [{ label: "⚠️ 重複の可能性", value: "この依頼は過去に承認済みの可能性があります(同一内容の依頼を再度承認しようとしています)。" }]
        : []),
      ...(verification?.warnings?.length
        ? verification.warnings.map((w, i) => ({ label: `⚠️ 警告${i + 1}`, value: w }))
        : []),
    ],
  }).then((hash) => {
    recordApprovedFingerprint(request);
    return hash;
  });
}
