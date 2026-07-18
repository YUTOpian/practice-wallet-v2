// harvest.js

import { appState } from "./config.js";

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
    const address = appState.currentAddress.toString();
    console.log("ハーベスト確認:", address);
    statusEl.textContent = "状態確認中...";

    /*
      アカウント情報取得
    */
    const accountRes = await fetch(`${appState.NODE}/accounts/${address}`);
    const accountJson = await accountRes.json();
    const account = accountJson.account;

    if (!account) {
      statusEl.textContent = "アカウント取得失敗";
      return;
    }

    /*
      Importance確認
    */
    const importance = BigInt(account.importance ?? 0);
    console.log("importance:", importance.toString());

    /*
      公開鍵リンク確認
    */
    const publicKey = account.publicKey;
    const hasPublicKey = publicKey && publicKey !== "0000000000000000000000000000000000000000000000000000000000000000";
    console.log("PublicKey:", hasPublicKey);

    /*
      ハーベスト資格判定
    */
    if (importance > 0n && hasPublicKey) {
      statusEl.textContent = "✅ ハーベスト設定可能";
    } else {
      statusEl.textContent = "❌ ハーベスト条件未達";
    }
  } catch(e) {
    console.error("Harvest error:", e);
    statusEl.textContent = "状態取得エラー";
  }
}

/* ============================================================
   ハーベスト開始
============================================================ */
export async function startHarvest() {
  console.log("ハーベスト開始処理");

  /*
    ここで
    ① PersistentHarvestingDelegationMessage作成
    ② Aggregate Bonded Transaction作成
    ③ SSS署名
    ④ announce
    を実装する
  */
}
