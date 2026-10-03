import type { Metadata } from "next";
import { StatefulForm } from "@/components/enterprise/StatefulForm";
import { Alert } from "@/components/ui/Alert";
import { Card } from "@/components/ui/Card";
import { ConfirmButton } from "@/components/ui/ConfirmButton";
import { Checkbox, Input, Select } from "@/components/ui/Field";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { getOrgLlmSettingsView, ORG_LLM_PROVIDERS, PROVIDER_LABEL, TASK_MODEL_TASKS } from "@/lib/data/llm-settings";
import { formatDate } from "@/lib/ui/format";
import { removeModelSettingsAction, saveModelSettingsAction, testModelSettingsAction } from "./actions";

export const metadata: Metadata = { title: "Model provider" };

/** Settings → Model provider (R4.6): bring your own LLM endpoint and key for this organization's model calls. */
export default async function ModelSettingsPage() {
  const ctx = await requireOrg({ permission: "settings.manage" });
  const current = await getOrgLlmSettingsView(db(), ctx.orgId);
  return (
    <>
      <Alert tone="info">
        {current
          ? `${ctx.orgName}'s reviews, conversations, and knowledge base use ${PROVIDER_LABEL[current.provider]}${current.baseUrl ? ` at ${current.baseUrl}` : ""} (saved ${formatDate(current.updatedAt)}).`
          : `${ctx.orgName} uses this server's default model. Save a provider below to send this organization's model calls to your own endpoint and key instead.`}{" "}
        Embeddings for code search keep using the server&apos;s embedding model.
      </Alert>
      <Card title="Provider" titleId="llm-provider" description="Your API key is encrypted at rest and never shown again after saving.">
        <StatefulForm action={saveModelSettingsAction} testId="llm-settings">
          <Select
            id="llm-provider-select"
            name="provider"
            label="Provider"
            options={ORG_LLM_PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABEL[p] }))}
            defaultValue={current?.provider ?? "anthropic"}
          />
          <Input
            id="llm-base-url"
            name="baseUrl"
            label="Base URL"
            help="Optional for Anthropic, OpenAI, and OpenRouter; required for OpenAI-compatible endpoints. Must be a public https URL."
            defaultValue={current?.baseUrl ?? ""}
            placeholder="https://llm.example.com/v1"
          />
          <Input
            id="llm-api-key"
            name="apiKey"
            label="API key"
            type="password"
            autoComplete="new-password"
            help={current?.hasApiKey ? "A key is saved (••••••••). Leave blank to keep it." : "Leave blank to use the server's key with the server's own provider."}
          />
          {current?.hasApiKey && <Checkbox id="llm-clear-key" name="clearApiKey" label="Remove the saved key" />}
          <Input id="llm-model" name="model" label="Default model" help="Required except for Anthropic, which has built-in defaults per task." defaultValue={current?.model ?? ""} />
          <details>
            <summary>Per-task models</summary>
            <div className="stack-md" style={{ marginTop: 12 }}>
              {TASK_MODEL_TASKS.map(({ task, label }) => (
                <Input key={task} id={`llm-task-${task}`} name={`taskModel.${task}`} label={label} defaultValue={current?.taskModels[task] ?? ""} placeholder="Default model" />
              ))}
            </div>
          </details>
          <div>
            <SubmitButton pendingLabel="Saving…">Save provider</SubmitButton>
          </div>
        </StatefulForm>
      </Card>
      <Card title="Test connection" titleId="llm-test" description="Sends one tiny classification request through the saved settings.">
        <StatefulForm action={testModelSettingsAction} testId="llm-test-form">
          <div>
            <SubmitButton pendingLabel="Testing…">Test connection</SubmitButton>
          </div>
        </StatefulForm>
      </Card>
      {current && (
        <Card title="Use the server default" titleId="llm-remove">
          <form action={removeModelSettingsAction}>
            <ConfirmButton prompt="Remove this provider and its key?" confirmLabel="Remove">
              Remove provider
            </ConfirmButton>
          </form>
        </Card>
      )}
    </>
  );
}
