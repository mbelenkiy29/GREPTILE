// The landing page's product visuals: interactive replicas of real dashboard screens (demo.tsx).
// The parts that need heavier code are rendered here on the server and passed in, so the browser
// never loads the markdown renderer or the review rules: chat answers and summaries as markdown,
// and the configuration previews computed with the same rules as guided setup.
import { ReviewMarkdown } from "../dashboard/markdown";
import { categories } from "../../src/engine/types";
import { previewComments, sampleFindings, triggerTimeline } from "../../src/onboarding-preview";
import { AgentDemo, AnalyticsDemo, AppDemo, ChatDemo, EvidenceDemo, SummaryDemo, type SettingsPreviews } from "./demo";
import { triggerFlags, triggerKey } from "./demo-logic";
import { chat, fixPush, history } from "./sample";

const answers = () => chat.answers.map((a) => <ReviewMarkdown key={a.question}>{a.answer}</ReviewMarkdown>);
const summaries = () => Object.fromEntries([...history, fixPush.revision].map((r) => [r.sha, <ReviewMarkdown key={r.sha}>{r.summary}</ReviewMarkdown>]));

function previews(): SettingsPreviews {
  const comments = Object.fromEntries([1, 2, 3].map((strictness) => [String(strictness),
    previewComments(sampleFindings, { strictness, severityThreshold: "medium", minimumConfidence: 0.85, categories, maxComments: 10 })]));
  // Every combination of the four trigger switches (16), keyed like the demo's switches.
  const triggers = Object.fromEntries(Array.from({ length: 2 ** triggerFlags.length }, (_, n) => {
    const on = Object.fromEntries(triggerFlags.map((k, i) => [k, Boolean(n & (1 << i))])) as Record<(typeof triggerFlags)[number], boolean>;
    return [triggerKey(on), triggerTimeline({ ...on, triggerLabels: [] })];
  }));
  return { comments, triggers };
}

export const ReviewReplica = () => <AppDemo answers={answers()} previews={previews()} />;
export const FindingReplica = () => <EvidenceDemo />;
export const SummaryReplica = () => <SummaryDemo summaries={summaries()} />;
export const ChatReplica = () => <ChatDemo answers={answers()} />;
export const AgentReplica = () => <AgentDemo />;
export const AnalyticsReplica = () => <AnalyticsDemo />;
