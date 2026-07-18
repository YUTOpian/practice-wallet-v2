// harvest.js
// Symbol SDK v3
// Delegated Harvesting

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
    console.log("Harvest check:", address);
    statusEl.textContent = "状態確認中...";

    /*
      Account取得
    */
    const response = await fetch(`${appState.NODE}/accounts/${address}`);
    const json = await response.json();
    const account = json.account;

    if (!account) {
      statusEl.textContent = "アカウント情報取得失敗";
      return;
    }

    /*
      Importance確認
    */
    const importance = BigInt(account.importance ?? 0);
    console.log("importance:", importance.toString());

    /*
      VRF / PublicKey確認
    */
    const publicKey = account.publicKey;
    const linked = publicKey && publicKey !== "0000000000000000000000000000000000000000000000000000000000000000";
    console.log("VRF linked:", linked);

    if (importance > 0n && linked) {
      statusEl.textContent = "✅ ハーベスト設定可能";
    } else {
      statusEl.textContent = "❌ ハーベスト条件不足";
    }
  } catch(error) {
    console.error("Harvest status error:", error);
    statusEl.textContent = "状態取得エラー";
  }
}

/* ============================================================
   ノード公開鍵取得
============================================================ */
export async function getNodePublicKey() {
  try {
    const response = await fetch(`${appState.NODE}/node/info`);
    const json = await response.json();
    const publicKey = json.node.publicKey;

    console.log("Node public key:", publicKey);
    return publicKey;
  } catch(error) {
    console.error("Node key error:", error);
    return null;
  }
}

/* ============================================================
   委任ハーベスト開始
============================================================ */
export async function startHarvest() {
  try {
    console.log("委任ハーベスト開始");

    /*
      ノード公開鍵取得
    */
    const nodePublicKey = await getNodePublicKey();
    if (!nodePublicKey) {
      throw new Error("ノード公開鍵取得失敗");
    }

    /*
      ここから Symbol SDK v3
      PersistentHarvestingDelegationMessage
      + HashLockTransaction
      + AggregateBondedTransaction を作成する
    */
    console.log("Delegation target:", nodePublicKey);

    /*
      TODO:
      1. PersistentHarvestingDelegationMessage生成
      2. TransferTransaction作成
      3. AggregateBonded作成
      4. HashLock作成
      5. SSS署名
      6. announce
    */
    return true;
  } catch(error) {
    console.error("Start harvest error:", error);
    return false;
  }
}

/* ============================================================
   ハーベスト停止
============================================================ */
export async function stopHarvest() {
  console.log("ハーベスト停止処理");
  /*
    Symbolでは停止Txではなく、委任解除処理になります。後実装
  */
}
