// Helpers shared by the dashboard page and its section components.
export const navigation = [
  "Overview",
  "Chat",
  "Repositories",
  "Reviews",
  "Findings",
  "Knowledge",
  "Rules",
  "Team",
  "Usage",
  "Settings",
];
export const when = (value: number) =>
  new Date(value).toLocaleString("en-US", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  }) + " UTC";
export const status = (value: string) => (
  <span className={`badge ${value}`}>{value.replaceAll("_", " ")}</span>
);
export function Empty({ title, text }: { title: string; text: string }) {
  return (
    <section className="empty">
      <h2>{title}</h2>
      <p>{text}</p>
    </section>
  );
}
