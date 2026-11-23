/** @returns {import("./catalog-model.mjs").CatalogKey} */
export function formatCatalogKey(label) {
  return label.trim().toLowerCase().replace(/\s+/g, "-");
}
