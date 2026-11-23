export function formatSummary(rows) {
  return rows.map((row) => `- ${row.label}`).join("\n");
}
