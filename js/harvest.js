// harvest.js
// 委任ハーベスティング (Delegated Harvesting) フル実装
//
// 手順:
//   ① AccountKeyLinkTransaction  … メインアカウントの重要度をリモート署名アカウントへ委任
//   ② VrfKeyLinkTransaction      … VRF鍵をメインアカウントにリンク（委任ハーベスト必須）
//   ③ NodeKeyLinkTransaction     … どのノードに委任するかをオンチェーンで宣言
//   ①②③は1つのAggregate Complete Transactionにまとめ、SSSで署名してアナウンスする
//   ④ PersistentDelegationRequestTransaction
//        … リモート鍵・VRF鍵の秘密鍵を「ノード宛」に暗号化したメッセージとして
//          TransferTransactionに載せて送る。これでノードがハーベスト委任を認識する。
//
// 参考: https://docs.symbol.dev/concepts/harvesting.html
//       https://docs.symbol.dev/guides/harvesting/activating-delegated-harvesting-manual.html

import { appState } from "./config.js";
import { setStatus } from "./ui.js";

/* ============================================================
   直近生成したリモート鍵・VRF鍵（セッション内のみ保持）
   ページをリロードすると消えるので、④が失敗した場合に備えて
   画面にも表示してユーザーに控えてもらう。
============================================================ */
let lastGeneratedKeys = null;

/* ============================================================
   ランダム秘密鍵生成（32byte）
============================================================ */
function randomPrivateKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return new appState.sdkCore.PrivateKey(bytes);
}

function toHex(bytesOrKey) {
  const bytes = bytesOrKey.bytes ?? bytesOrKey;
  return appState.sdkCore.utils.uint8ToHex(bytes);
}

/* ============================================================
   ノード公開鍵取得 (/node/info の nodePublicKey)
   ※ これは NodeKeyLinkTransaction 用の鍵であり、
     REST証明書(CA)公開鍵とは別物なので注意
============================================================ */
async function fetchNodePublicKey() {
  const res = await fetch(new URL("/node/info", appState.NODE));
  const info = await res.json();
  if (!info.nodePublicKey) {
    throw new Error("ノードから nodePublicKey を取得できませんでした");
  }
  return new appState.sdkCore.PublicKey(info.nodePublicKey);
}

/* ============================================================
   ハーベスト状態確認
============================================================ */
export async function checkHarvestStatus() {
  const statusEl = document.getElementById("harvest-status");
  const importanceEl = document.getElementById("harvest-importance");
  if (!statusEl) return;

  try {
    statusEl.textContent = "状態確認中...";

    const address = appState.currentAddress.toString();
    const res = await fetch(`${appState.NODE}/accounts/${address}`);
    const json = await res.json();
    const account = json.account;

    if (!account) {
      statusEl.textContent = "アカウント情報取得失敗";
      return;
    }

    const importance = account.importance;
    console.log("importance:", importance);

    if (importanceEl) {
      importanceEl.textContent = importance ? BigInt(importance).toString() : "0";
    }

    // supplementalPublicKeys があれば委任状況もついでに表示
    const keys = account.supplementalPublicKeys;
    const linkedInfo = keys
      ? `linked:${!!keys.linked} vrf:${!!keys.vrf} node:${!!keys.node}`
      : "";

    if (importance && Number(importance) > 0) {
      statusEl.textContent = `✅ ハーベスト可能状態 ${linkedInfo}`;
    } else {
      statusEl.textContent = `❌ ハーベスト未設定 ${linkedInfo}`;
    }
  } catch (e) {
    console.error("Harvest status error:", e);
    statusEl.textContent = "状態取得エラー";
  }
}

/* ============================================================
   トランザクション確認待ち（承認 or 失敗まで polling）
============================================================ */
async function waitConfirmed(hash, { timeoutMs = 60000, intervalMs = 3000 } = {}) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${appState.NODE}/transactionStatus/${hash}`);
      if (res.ok) {
        const json = await res.json();
        if (json.group === "confirmed") return true;
        if (json.group === "failed") {
          throw new Error("Transaction failed: " + (json.code ?? "unknown"));
        }
      }
    } catch (e) {
      // 404 = まだunconfirmedにも乗っていない可能性があるので継続
      console.warn("waitConfirmed polling error:", e);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error("承認待ちがタイムアウトしました");
}

/* ============================================================
   SSSで署名 → アナウンス（共通処理）
============================================================ */
async function signAndAnnounce(tx) {
  const payload = appState.sdkCore.utils.uint8ToHex(tx.serialize());

  window.SSS.setTransactionByPayload(payload);
  const signed = await window.SSS.requestSign();

  if (!signed?.payload) {
    throw new Error("SSS署名に失敗しました");
  }

  const res = await fetch(new URL("/transactions", appState.NODE), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload: signed.payload }),
  });

  const result = await res.json();
  console.log("announce result:", result);

  if (!res.ok) {
    throw new Error(result.message ?? "アナウンス失敗");
  }

  const hash = appState.facade.hashTransaction(tx).toString();
  return hash;
}

/* ============================================================
   ① + ② + ③ を1つのAggregate Complete Transactionにまとめて送信
============================================================ */
async function announceKeyLinks(remoteKeyPair, vrfKeyPair, nodePublicKey) {
  const { descriptors, models } = appState.sdkSymbol;

  const embedded = [
    appState.facade.createEmbeddedTransactionFromTypedDescriptor(
      new descriptors.AccountKeyLinkTransactionV1Descriptor(
        remoteKeyPair.publicKey,
        models.LinkAction.LINK
      ),
      appState.currentPubKey
    ),
    appState.facade.createEmbeddedTransactionFromTypedDescriptor(
      new descriptors.VrfKeyLinkTransactionV1Descriptor(
        vrfKeyPair.publicKey,
        models.LinkAction.LINK
      ),
      appState.currentPubKey
    ),
    appState.facade.createEmbeddedTransactionFromTypedDescriptor(
      new descriptors.NodeKeyLinkTransactionV1Descriptor(
        nodePublicKey,
        models.LinkAction.LINK
      ),
      appState.currentPubKey
    ),
  ];

  const aggregateDescriptor = new descriptors.AggregateCompleteTransactionV2Descriptor(
    appState.facade.hashEmbeddedTransactions(embedded),
    embedded
  );

  const aggregateTx = appState.facade.createTransactionFromTypedDescriptor(
    aggregateDescriptor,
    appState.currentPubKey,
    100,
    60 * 60
  );

  return await signAndAnnounce(aggregateTx);
}

/* ============================================================
   ④ PersistentDelegationRequestTransaction の作成・送信
   ※ ここは symbol-sdk のバージョンによってAPI名が変わりやすい部分。
     見つからない場合は encoder のプロパティ一覧をconsoleに出して
     原因を特定できるようにしている。
============================================================ */
async function announcePersistentDelegationRequest(remoteKeyPair, vrfKeyPair, nodePublicKey) {
  const { descriptors, MessageEncoder } = appState.sdkSymbol;

  if (typeof MessageEncoder !== "function") {
    throw new Error(
      "このSDKバージョンには MessageEncoder が見つかりません。sdk.js で読み込んでいる " +
      "symbol-sdk のバンドル内容を console.log(appState.sdkSymbol) で確認してください。"
    );
  }

  // 暗号化自体はメインアカウントの秘密鍵を必要としない
  // （SDKが内部でephemeralな鍵を都度生成しノード公開鍵とECDHするため）。
  // encoder の生成にダミーのKeyPairが必要なSDKもあるので、その場合は
  // ランダム鍵で作ったAccount相当のオブジェクトを渡す。
  let encodedMessage;
  try {
    const dummyKeyPair = new appState.sdkSymbol.KeyPair(randomPrivateKey());
    const encoder = new MessageEncoder(dummyKeyPair);

    if (typeof encoder.encodePersistentHarvestingDelegation === "function") {
      encodedMessage = encoder.encodePersistentHarvestingDelegation(
        nodePublicKey,
        remoteKeyPair,
        vrfKeyPair
      );
    } else {
      console.warn(
        "encodePersistentHarvestingDelegation が見つかりません。利用可能なメソッド:",
        Object.getOwnPropertyNames(Object.getPrototypeOf(encoder))
      );
      throw new Error("MessageEncoderに委任メッセージ用のメソッドが見つかりませんでした");
    }
  } catch (e) {
    console.error("Persistent delegation message encode error:", e);
    throw e;
  }

  const nodeAddress = appState.sdkSymbol.Address.fromPublicKey
    ? appState.sdkSymbol.Address.fromPublicKey(nodePublicKey, appState.networkType)
    : appState.facade.network.publicKeyToAddress(nodePublicKey);

  const transferDescriptor = new descriptors.TransferTransactionV1Descriptor(
    nodeAddress,
    [],
    encodedMessage
  );

  const transferTx = appState.facade.createTransactionFromTypedDescriptor(
    transferDescriptor,
    appState.currentPubKey,
    100,
    60 * 60
  );

  return await signAndAnnounce(transferTx);
}

/* ============================================================
   委任ハーベスティング開始（メインエントリポイント）
============================================================ */
export async function startHarvest() {
  const statusEl = document.getElementById("harvest-status");
  const setLine = (text) => {
    if (statusEl) statusEl.textContent = text;
    console.log("[harvest]", text);
  };

  try {
    if (!appState.facade || !appState.currentPubKey) {
      throw new Error("SDK未初期化またはアカウント未接続です");
    }

    setLine("ノード情報取得中...");
    const nodePublicKey = await fetchNodePublicKey();

    setLine("リモート鍵・VRF鍵を生成中...");
    const remoteKeyPair = new appState.sdkSymbol.KeyPair(randomPrivateKey());
    const vrfKeyPair = new appState.sdkSymbol.KeyPair(randomPrivateKey());

    // 画面に残しておく（④が失敗しても後で再送できるように）
    lastGeneratedKeys = {
      remotePrivateKey: toHex(remoteKeyPair.privateKey),
      vrfPrivateKey: toHex(vrfKeyPair.privateKey),
    };
    console.warn(
      "生成したリモート鍵・VRF鍵の秘密鍵（この画面を閉じると失われます。再送が必要な場合のため控えてください）:",
      lastGeneratedKeys
    );

    setLine("① AccountKeyLink / ② VrfKeyLink / ③ NodeKeyLink をSSSで署名してください...");
    const aggHash = await announceKeyLinks(remoteKeyPair, vrfKeyPair, nodePublicKey);
    setLine(`鍵リンクTx送信済み (${aggHash.slice(0, 12)}...) 承認待ち...`);

    await waitConfirmed(aggHash);
    setLine("鍵リンク承認完了。④ 委任リクエストを送信します...");

    const delegationHash = await announcePersistentDelegationRequest(
      remoteKeyPair,
      vrfKeyPair,
      nodePublicKey
    );

    setLine(`✅ 委任リクエスト送信完了 (${delegationHash.slice(0, 12)}...)。ノード側の反映をお待ちください。`);
    alert(
      "委任ハーベスティングの設定リクエストを送信しました。\n" +
      "ノードが承諾すると数分〜数十分程度でハーベストが始まる場合があります。\n" +
      "（ノード側の判断次第のため、必ず開始される保証はありません）"
    );
  } catch (e) {
    console.error("startHarvest error:", e);
    setLine("❌ ハーベスト設定失敗: " + e.message);
    alert("ハーベスト設定失敗: " + e.message);
  }
}

/* ============================================================
   委任解除（Unlink）
   ※ 停止する場合は ①②③ を LinkAction.UNLINK で同じキーを使って
     再アナウンスする必要がある（symbol仕様）。
     現在保持しているキーが無い場合は解除できない点に注意。
============================================================ */
export async function stopHarvest() {
  const statusEl = document.getElementById("harvest-status");
  if (!lastGeneratedKeys) {
    alert(
      "このセッションで生成したリモート鍵・VRF鍵の情報がありません。\n" +
      "解除するには、当時使用した鍵情報が必要です。"
    );
    return;
  }
  // TODO: announceKeyLinks と同様の構成で LinkAction.UNLINK を使って実装
  alert("停止処理は未実装です。UNLINKトランザクションの実装が必要です。");
}
