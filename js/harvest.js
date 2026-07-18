export async function startHarvest() {
  try {
    console.log("委任ハーベスト開始");

    if (!appState.facade) {
      throw new Error("SDK未初期化");
    }

    const linkedPublicKey = appState.currentPubKey;
    if (!linkedPublicKey) {
      throw new Error("公開鍵取得失敗");
    }

    /*
      AccountKeyLink Transaction
    */
    const descriptor = new appState.sdkSymbol.descriptors.AccountKeyLinkTransactionV1Descriptor(
      linkedPublicKey,
      appState.sdkSymbol.models.LinkAction.Link
    );

    const tx = appState.facade.createTransactionFromTypedDescriptor(
      descriptor,
      appState.currentPubKey,
      100,
      60 * 60
    );

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
      body: JSON.stringify({
        payload: signed.payload
      })
    });

    if (res.ok) {
      alert("委任ハーベスト設定トランザクションを送信しました");
    } else {
      console.error(await res.text());
      throw new Error("アナウンス失敗");
    }
  } catch (e) {
    console.error("startHarvest error:", e);
    alert("ハーベスト設定失敗: " + e.message);
  }
}
