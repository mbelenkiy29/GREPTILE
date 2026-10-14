/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agentContext from "../agentContext.js";
import type * as agentToolbox from "../agentToolbox.js";
import type * as agentTools from "../agentTools.js";
import type * as analytics from "../analytics.js";
import type * as apiKeys from "../apiKeys.js";
import type * as approvalJobs from "../approvalJobs.js";
import type * as approvals from "../approvals.js";
import type * as atlassianJobs from "../atlassianJobs.js";
import type * as auth from "../auth.js";
import type * as bitbucketPersonal from "../bitbucketPersonal.js";
import type * as bridge from "../bridge.js";
import type * as bridgeJobs from "../bridgeJobs.js";
import type * as budgetModel from "../budgetModel.js";
import type * as cache from "../cache.js";
import type * as chat from "../chat.js";
import type * as chatJobs from "../chatJobs.js";
import type * as context from "../context.js";
import type * as conventionJobs from "../conventionJobs.js";
import type * as conventions from "../conventions.js";
import type * as conversationJobs from "../conversationJobs.js";
import type * as conversations from "../conversations.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as embeddings from "../embeddings.js";
import type * as feedbackCore from "../feedbackCore.js";
import type * as fileReads from "../fileReads.js";
import type * as findings from "../findings.js";
import type * as graphDiagnostics from "../graphDiagnostics.js";
import type * as http from "../http.js";
import type * as indexAuthority from "../indexAuthority.js";
import type * as inferenceBudget from "../inferenceBudget.js";
import type * as integrationJobs from "../integrationJobs.js";
import type * as integrations from "../integrations.js";
import type * as jobs from "../jobs.js";
import type * as knowledge from "../knowledge.js";
import type * as knowledgeJobs from "../knowledgeJobs.js";
import type * as memory from "../memory.js";
import type * as notificationJobs from "../notificationJobs.js";
import type * as notifications from "../notifications.js";
import type * as notionData from "../notionData.js";
import type * as notionJobs from "../notionJobs.js";
import type * as onboarding from "../onboarding.js";
import type * as p4ConversationJobs from "../p4ConversationJobs.js";
import type * as p4Conversations from "../p4Conversations.js";
import type * as p4FixAuthority from "../p4FixAuthority.js";
import type * as p4Identities from "../p4Identities.js";
import type * as p4IdentityJobs from "../p4IdentityJobs.js";
import type * as p4Index from "../p4Index.js";
import type * as p4IndexJobs from "../p4IndexJobs.js";
import type * as p4PollJobs from "../p4PollJobs.js";
import type * as p4Polling from "../p4Polling.js";
import type * as p4ReviewJobs from "../p4ReviewJobs.js";
import type * as p4Reviews from "../p4Reviews.js";
import type * as p4ShelfJobs from "../p4ShelfJobs.js";
import type * as providerConnections from "../providerConnections.js";
import type * as providerIdentities from "../providerIdentities.js";
import type * as providerIdentityJobs from "../providerIdentityJobs.js";
import type * as providerInstalls from "../providerInstalls.js";
import type * as providerJobs from "../providerJobs.js";
import type * as pullCatalogJobs from "../pullCatalogJobs.js";
import type * as pullCatalogs from "../pullCatalogs.js";
import type * as pullReviewJobs from "../pullReviewJobs.js";
import type * as pulls from "../pulls.js";
import type * as rateLimit from "../rateLimit.js";
import type * as reactionJobs from "../reactionJobs.js";
import type * as reactions from "../reactions.js";
import type * as recovery from "../recovery.js";
import type * as removeFile from "../removeFile.js";
import type * as repositories from "../repositories.js";
import type * as repositoryContext from "../repositoryContext.js";
import type * as repositoryContextJobs from "../repositoryContextJobs.js";
import type * as repositoryContextTypes from "../repositoryContextTypes.js";
import type * as repositoryIdentity from "../repositoryIdentity.js";
import type * as reviewLifecycle from "../reviewLifecycle.js";
import type * as reviews from "../reviews.js";
import type * as runtime from "../runtime.js";
import type * as runtimeJobs from "../runtimeJobs.js";
import type * as scm from "../scm.js";
import type * as scopes from "../scopes.js";
import type * as searchData from "../searchData.js";
import type * as searchJobs from "../searchJobs.js";
import type * as semanticSearch from "../semanticSearch.js";
import type * as settings from "../settings.js";
import type * as team from "../team.js";
import type * as usage from "../usage.js";
import type * as users from "../users.js";
import type * as webhookJobs from "../webhookJobs.js";
import type * as webhooks from "../webhooks.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agentContext: typeof agentContext;
  agentToolbox: typeof agentToolbox;
  agentTools: typeof agentTools;
  analytics: typeof analytics;
  apiKeys: typeof apiKeys;
  approvalJobs: typeof approvalJobs;
  approvals: typeof approvals;
  atlassianJobs: typeof atlassianJobs;
  auth: typeof auth;
  bitbucketPersonal: typeof bitbucketPersonal;
  bridge: typeof bridge;
  bridgeJobs: typeof bridgeJobs;
  budgetModel: typeof budgetModel;
  cache: typeof cache;
  chat: typeof chat;
  chatJobs: typeof chatJobs;
  context: typeof context;
  conventionJobs: typeof conventionJobs;
  conventions: typeof conventions;
  conversationJobs: typeof conversationJobs;
  conversations: typeof conversations;
  crons: typeof crons;
  dashboard: typeof dashboard;
  embeddings: typeof embeddings;
  feedbackCore: typeof feedbackCore;
  fileReads: typeof fileReads;
  findings: typeof findings;
  graphDiagnostics: typeof graphDiagnostics;
  http: typeof http;
  indexAuthority: typeof indexAuthority;
  inferenceBudget: typeof inferenceBudget;
  integrationJobs: typeof integrationJobs;
  integrations: typeof integrations;
  jobs: typeof jobs;
  knowledge: typeof knowledge;
  knowledgeJobs: typeof knowledgeJobs;
  memory: typeof memory;
  notificationJobs: typeof notificationJobs;
  notifications: typeof notifications;
  notionData: typeof notionData;
  notionJobs: typeof notionJobs;
  onboarding: typeof onboarding;
  p4ConversationJobs: typeof p4ConversationJobs;
  p4Conversations: typeof p4Conversations;
  p4FixAuthority: typeof p4FixAuthority;
  p4Identities: typeof p4Identities;
  p4IdentityJobs: typeof p4IdentityJobs;
  p4Index: typeof p4Index;
  p4IndexJobs: typeof p4IndexJobs;
  p4PollJobs: typeof p4PollJobs;
  p4Polling: typeof p4Polling;
  p4ReviewJobs: typeof p4ReviewJobs;
  p4Reviews: typeof p4Reviews;
  p4ShelfJobs: typeof p4ShelfJobs;
  providerConnections: typeof providerConnections;
  providerIdentities: typeof providerIdentities;
  providerIdentityJobs: typeof providerIdentityJobs;
  providerInstalls: typeof providerInstalls;
  providerJobs: typeof providerJobs;
  pullCatalogJobs: typeof pullCatalogJobs;
  pullCatalogs: typeof pullCatalogs;
  pullReviewJobs: typeof pullReviewJobs;
  pulls: typeof pulls;
  rateLimit: typeof rateLimit;
  reactionJobs: typeof reactionJobs;
  reactions: typeof reactions;
  recovery: typeof recovery;
  removeFile: typeof removeFile;
  repositories: typeof repositories;
  repositoryContext: typeof repositoryContext;
  repositoryContextJobs: typeof repositoryContextJobs;
  repositoryContextTypes: typeof repositoryContextTypes;
  repositoryIdentity: typeof repositoryIdentity;
  reviewLifecycle: typeof reviewLifecycle;
  reviews: typeof reviews;
  runtime: typeof runtime;
  runtimeJobs: typeof runtimeJobs;
  scm: typeof scm;
  scopes: typeof scopes;
  searchData: typeof searchData;
  searchJobs: typeof searchJobs;
  semanticSearch: typeof semanticSearch;
  settings: typeof settings;
  team: typeof team;
  usage: typeof usage;
  users: typeof users;
  webhookJobs: typeof webhookJobs;
  webhooks: typeof webhooks;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
