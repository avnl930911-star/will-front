const text = (value) => value == null ? "" : String(value).trim();
const rows = (state, domain) => Array.isArray(state?.records?.[domain]) ? state.records[domain] : [];

/**
 * Returns live expert metadata. `id`/`key` are stable record handles; display names
 * are intentionally resolved at render time so a rename updates labels and boards.
 */
export function getExpertRegistry(state) {
  return rows(state, "experts").map((record, index) => {
    const id = text(record?.id || record?.key || record?.catalogKey) || `expert-${index + 1}`;
    const key = text(record?.key || record?.catalogKey || id);
    const name = text(record?.name || record?.nickname || record?.loginId) || "전문가 미지정";
    return {
      id,
      key,
      catalogKey: text(record?.catalogKey || key),
      name,
      freeBoard: text(record?.freeBoard) || `${name} 게시판`,
      record
    };
  });
}

/**
 * Product groups are derived only from current product records. A hidden product is
 * still an admin group; removing its record merely removes the navigation group and
 * never mutates member or payment history.
 */
export function getProductGroups(state) {
  const experts = getExpertRegistry(state);
  const byHandle = new Map();
  experts.forEach((expert) => {
    [expert.id, expert.key, expert.catalogKey, expert.name].filter(Boolean).forEach((handle) => byHandle.set(handle, expert));
  });
  return rows(state, "products").map((product, index) => {
    const productId = text(product?.id || product?.key || product?.catalogKey) || `product-${index + 1}`;
    const name = text(product?.title || product?.name) || "상품명 미입력";
    const owner = byHandle.get(text(product?.expertId || product?.expertKey || product?.expert));
    const aliases = Array.from(new Set([
      ...(Array.isArray(product?.legacyTitles) ? product.legacyTitles : []),
      ...(Array.isArray(product?.previousTitles) ? product.previousTitles : [])
    ].map(text).filter(Boolean)));
    return {
      id: productId,
      name,
      productId,
      expertId: owner?.id || text(product?.expertId || product?.expertKey),
      expert: owner?.name || text(product?.expert) || "전문가 미지정",
      aliases,
      display: product?.display,
      record: product
    };
  });
}

export function matchesExpert(record, expert) {
  if (!record || !expert) return false;
  const handles = [record.expertId, record.expertKey, record.expertCatalogKey, record.expert, record.board]
    .map(text)
    .filter(Boolean);
  return handles.includes(expert.id) || handles.includes(expert.key) || handles.includes(expert.catalogKey) || handles.includes(expert.name) || handles.includes(expert.freeBoard);
}

export function matchesProductMembership(member, group) {
  if (!member || !group) return false;
  const matches = (service) => {
    const id = text(service?.productId || service?.productID || service?.productKey || service?.catalogKey);
    const name = text(service?.product || service?.group);
    return id === group.productId || (!id && (name === group.name || group.aliases?.includes(name)));
  };
  if (Array.isArray(member.services)) return member.services.some((service) => service && text(service.status) !== "환불" && matches(service));
  const id = text(member.productId || member.productID || member.productKey);
  const name = text(member.group);
  return id === group.productId || (!id && (name === group.name || group.aliases?.includes(name)));
}
