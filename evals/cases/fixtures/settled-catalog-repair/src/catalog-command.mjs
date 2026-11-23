/** @returns {import("./catalog-model.mjs").CatalogKey} */
export function run(label) {
  return label.trim().toLowerCase();
}
