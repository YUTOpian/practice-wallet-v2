// namespace.js
// ネームスペースの登録(ルート/子)・自分が保有するネームスペース一覧の取得

import { appState } from "./config.js";
import { setStatus } from "./ui.js";
import { signAndAnnounceTx } from "./auth.js";

/* ============================================================
   保有ネームスペース一覧
============================================================ */
export async function loadOwnedNamespaces() {
  const el = document.getElementById("namespace-list");
  if (!el) return;

  el.textContent = "読み込み中...";

  try {
    const address = appState.currentAddress.toString();
    const params = new URLSearchParams({
      ownerAddress: address,
      pageSize: 100,
    });
    const res = await fetch(`${appState.NODE}/namespaces?${params}`);
    const json = await res.json();
    const items = json.data ?? [];

    if (items.length === 0) {
      el.innerHTML = `<div style="color:#94a3b8;">保有しているネームスペースはありません</div>`;
      return;
    }

    el.innerHTML = items
      .map((item) => {
        const ns = item.namespace;
        const level = ns.depth === 1 ? "ルート" : `子(レベル${ns.depth})`;
        const fullName = (ns.levels || [])
          .map((l) => l) // レベルのnamespaceId(hex)一覧。名前解決はしない簡易表示
          .join(" / ");
        const aliasType = ns.alias?.type;
        const aliasInfo =
          aliasType === 1
            ? `モザイクエイリアス: ${ns.alias.mosaicId}`
            : aliasType === 2
            ? `アドレスエイリアス`
            : "エイリアスなし";

        return `
          <div class="harvest-history-item">
            <div>種別: ${level}</div>
            <div>NamespaceId: ${ns.level0 ?? ns.id}</div>
            <div>${aliasInfo}</div>
            <div>失効高さ: ${ns.endHeight}</div>
          </div>
        `;
      })
      .join("");
  } catch (e) {
    console.error("loadOwnedNamespaces error:", e);
    el.textContent = "取得に失敗しました";
  }
}

/* ============================================================
   ルートネームスペース候補(子ネームスペース登録時の親選択用)
============================================================ */
export async function populateParentNamespaceSelect() {
  const select = document.getElementById("child-namespace-parent-select");
  if (!select) return;

  select.innerHTML = `<option value="">-- 読み込み中... --</option>`;

  try {
    const address = appState.currentAddress.toString();
    const params = new URLSearchParams({ ownerAddress: address, pageSize: 100 });
    const res = await fetch(`${appState.NODE}/namespaces?${params}`);
    const json = await res.json();
    const items = json.data ?? [];

    const namesRes = await fetch(`${appState.NODE}/namespaces/names`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespaceIds: items.map((i) => i.namespace.level0 ?? i.namespace.id) }),
    }).then((r) => r.json());

    const nameMap = {};
    for (const n of namesRes || []) {
      nameMap[n.id] = n.name;
    }

    if (items.length === 0) {
      select.innerHTML = `<option value="">-- 保有ネームスペースがありません --</option>`;
      return;
    }

    select.innerHTML =
      `<option value="">-- 親ネームスペースを選択 --</option>` +
      items
        .map((item) => {
          const ns = item.namespace;
          const id = ns.level0 ?? ns.id;
          const name = nameMap[id] ?? id;
          return `<option value="${id}">${name}</option>`;
        })
        .join("");
  } catch (e) {
    console.warn("親ネームスペース候補の取得に失敗しました", e);
    select.innerHTML = `<option value="">-- 取得に失敗しました --</option>`;
  }
}

/* ============================================================
   ルートネームスペース登録
============================================================ */
export async function registerRootNamespace(name, durationBlocks) {
  const { descriptors, models } = appState.sdkSymbol;

  const namespaceId = new models.NamespaceId(appState.sdkSymbol.generateNamespaceId(name));

  const descriptor = new descriptors.NamespaceRegistrationTransactionV1Descriptor(
    namespaceId,
    models.NamespaceRegistrationType.ROOT,
    new models.BlockDuration(BigInt(durationBlocks)),
    undefined,
    name
  );

  const tx = appState.facade.createTransactionFromTypedDescriptor(
    descriptor,
    appState.currentPubKey,
    appState.feeMultiplier ?? 100,
    60 * 60
  );

  return await signAndAnnounceTx(tx);
}

/* ============================================================
   子ネームスペース登録
============================================================ */
export async function registerChildNamespace(parentIdHex, childName) {
  const { descriptors, models } = appState.sdkSymbol;

  const parentId = new models.NamespaceId(BigInt("0x" + parentIdHex));
  const namespaceId = new models.NamespaceId(
    appState.sdkSymbol.generateNamespaceId(childName, parentId.value)
  );

  const descriptor = new descriptors.NamespaceRegistrationTransactionV1Descriptor(
    namespaceId,
    models.NamespaceRegistrationType.CHILD,
    undefined,
    parentId,
    childName
  );

  const tx = appState.facade.createTransactionFromTypedDescriptor(
    descriptor,
    appState.currentPubKey,
    appState.feeMultiplier ?? 100,
    60 * 60
  );

  return await signAndAnnounceTx(tx);
}
