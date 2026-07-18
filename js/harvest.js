// harvest.js

import { appState } from "./config.js";
import { hexToUint8Array } from "./utils.js";

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

    if (importance && Number(importance) > 0) {
      statusEl.textContent = "✅ ハーベスト可能状態";
    } else {
      statusEl.textContent = "❌ ハーベスト未設定";
    }
  } catch (e) {
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

    if (!appState.currentPubKey) {
      throw new Error("公開鍵取得失敗");
    }

    /*
      HEX公開鍵 → Uint8Array
    */
    const publicKeyBytes = hexToUint8Array(appState.currentPubKey);
    console.log("publicKey length:", publicKeyBytes.length);

    if (publicKeyBytes.length !== 32) {
      throw new Error("公開鍵サイズ異常: " + publicKeyBytes.length);
    }

    /*
      AccountKeyLink
    */
    const linkedPublicKey = new appState.sdkSymbol.models.PublicKey(publicKeyBytes);
    const descriptor = new appState.sdkSymbol.descriptors.AccountKeyLinkTransactionV1Descriptor(
      linkedPublicKey,
      appState.sdkSymbol.models.LinkAction.Link
    );
    console.log("descriptor:", descriptor.toMap());

    /*
      ★ここが変更点
      PublicKeyではなくUint8Arrayを渡す
    */
    const tx = appState.facade.createTransactionFromTypedDescriptor(
      descriptor,
      publicKeyBytes,
      100,
      60 * 60
    );
    console.log("transaction:", tx);

    const payload = appState.sdkCore.utils.uint8ToHex(tx.serialize());
    console.log("payload:", payload);

    window.SSS.setTransactionByPayload(payload);
    const signed = await window.SSS.requestSign();

    const res = await fetch(`${appState.NODE}/transactions`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ payload: signed.payload })
    });

    if (res.ok) {
      alert("ハーベスト設定トランザクションを送信しました");
    } else {
      console.error(await res.text());
      throw new Error("アナウンス失敗");
    }
  } catch (e) {
    console.error("startHarvest error:", e);
    alert("ハーベスト設定失敗: " + e.message);
  }
}
