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
      公開鍵 HEX → Uint8Array(32byte)
    */
    const publicKeyHex = appState.currentPubKey;
    const publicKeyBytes = hexToUint8Array(publicKeyHex);
    console.log("publicKeyBytes:", publicKeyBytes, publicKeyBytes.length);

    if (publicKeyBytes.length !== 32) {
      throw new Error("公開鍵サイズ異常: " + publicKeyBytes.length);
    }

    /*
      AccountKeyLink用 PublicKey
    */
    const linkedPublicKey = new appState.sdkSymbol.models.PublicKey(publicKeyBytes);
    console.log("linkedPublicKey:", linkedPublicKey);

    /*
      AccountKeyLinkTransaction Descriptor
      SDK v3: constructor(linkedPublicKey, linkAction)
    */
    const descriptor = new appState.sdkSymbol.descriptors.AccountKeyLinkTransactionV1Descriptor(
      linkedPublicKey,
      appState.sdkSymbol.models.LinkAction.Link
    );
    console.log("descriptor:", descriptor);

    /*
      署名者PublicKey
    */
    const signerPublicKey = new appState.sdkSymbol.models.PublicKey(publicKeyBytes);

    /*
      Transaction生成
    */
    const tx = appState.facade.createTransactionFromTypedDescriptor(
      descriptor,
      signerPublicKey,
      100,
      60 * 60
    );
    console.log("transaction:", tx);

    const payload = appState.sdkCore.utils.uint8ToHex(tx.serialize());
    console.log("Harvest payload:", payload);

    /*
      SSS署名
    */
    window.SSS.setTransactionByPayload(payload);
    const signed = await window.SSS.requestSign();

    /*
      アナウンス
    */
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
      const text = await res.text();
      console.error(text);
      throw new Error("アナウンス失敗");
    }
  } catch (e) {
    console.error("startHarvest error:", e);
    alert("ハーベスト設定失敗: " + e.message);
  }
}
