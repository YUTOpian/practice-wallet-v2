// harvest.js
// 委任ハーベスト管理
// Symbol SDK v3対応

import { appState } from "./config.js";
import { signTransaction } from "./sss.js";

/* ============================================================
   ハーベスト状態確認
============================================================ */
export async function checkHarvestStatus() {
  const statusEl = document.getElementById("harvest-status");
  if (!statusEl) {
    console.log("harvest-status がありません");
    return;
  }

  try {
    statusEl.textContent = "状態確認中...";
    const address = appState.currentAddress.toString();
    const url = `${appState.NODE}/accounts/${address}`;

    console.log("REST:", url);
    const res = await fetch(url);
    const json = await res.json();
    const account = json.account;

    if (!account) {
      statusEl.textContent = "アカウント情報取得失敗";
      return;
    }

    const importance = account.importance;
    console.log("importance:", importance);

    if (importance && Number(importance) > 0) {
      statusEl.textContent = "✅ ハーベスト可能状態";
    } else {
      statusEl.textContent = "❌ ハーベスト未設定";
    }
  } catch(e) {
    console.error("Harvest status error:", e);
    statusEl.textContent = "状態取得エラー";
  }
}

/* ============================================================
   委任ハーベスト開始
============================================================ */
export async function startHarvest() {
  try {
    console.log("委任ハーベスト開始");
    if (!appState.facade) {
      throw new Error("SDK未初期化");
    }

    /*
      現在アカウント
    */
    const address = appState.currentAddress;

    /*
      リモートハーベスト用キー
      本来ここでVRF / VotingKey設定状態などを確認
    */
    const linkedPublicKey = appState.currentPubKey;
    if (!linkedPublicKey) {
      throw new Error("公開鍵取得失敗");
    }

    /*
      Transaction作成
      ※ Symbol SDK v3 実際のKeyLinkTransaction生成部分
    */
    const deadline = appState.facade.network.createDeadline();
    const transaction = new appState.sdkSymbol.KeyLinkTransactionBuilder(); // 構築用

    console.log("作成Transaction:", transaction);

    /*
      SSS署名
    */
    const signedTx = await signTransaction(transaction);
    console.log("署名済み:", signedTx);

    /*
      アナウンス
    */
    const payload = signedTx.payload;
    const res = await fetch(`${appState.NODE}/transactions`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ payload })
    });

    const result = await res.json();
    console.log("announce:", result);

    alert("委任ハーベスト設定トランザクションを送信しました");
  } catch(e) {
    console.error("startHarvest error:", e);
    alert("ハーベスト設定失敗: " + e.message);
  }
}

/* ============================================================
   委任ハーベスト解除
============================================================ */
export async function stopHarvest() {
  console.log("委任ハーベスト解除");
  /*
    後で AccountKeyLinkTransaction LinkAction.Unlink を実装
  */
}
