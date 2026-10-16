import {defaults} from './review-settings';

/** Preserve configured empty selections; older clients inherit existing defaults. */
export function scopeSettingsFromForm(form:FormData){
 const value=(key:string)=>String(form.get(key)??'');
 const list=(key:string)=>value(key).split(',').map(s=>s.trim()).filter(Boolean);
 return {...defaults,
  automatic:form.has('automatic'),drafts:form.has('drafts'),rereview:form.has('rereview'),
  maxComments:Number(value('maxComments')),minimumConfidence:Number(value('minimumConfidence')),
  instructions:value('instructions'),targetBranches:list('targetBranches'),ignoredBranches:list('ignoredBranches'),ignoredPaths:list('ignoredPaths'),
  model:value('model'),mode:value('mode')||defaults.mode,severityThreshold:value('severityThreshold')||defaults.severityThreshold,
  categories:form.has('categoriesConfigured')?form.getAll('categories').map(String):defaults.categories,
  summarySections:form.has('summaryConfigured')?form.getAll('summarySections').map(String):defaults.summarySections,
  commentStyle:value('commentStyle')||defaults.commentStyle,
  reviewEngine:value('reviewEngine')||defaults.reviewEngine,
  checkFailureSeverity:value('checkFailureSeverity')||defaults.checkFailureSeverity,
  checkMinimumScore:Number(value('checkMinimumScore')||defaults.checkMinimumScore),
  summaryPlacement:value('summaryPlacement')||defaults.summaryPlacement,
  triggerLabels:list('triggerLabels'),excludedAuthors:list('excludedAuthors'),
  maxFiles:Number(value('maxFiles')||0),maxChangedLines:Number(value('maxChangedLines')||0),strictness:Number(value('strictness')||0),
  lockedKeys:form.has('lockedConfigured')?form.getAll('lockedKeys').map(String):defaults.lockedKeys,
  autoApproveConventions:form.has('autoApproveConventions'),
  fixPullRequests:form.has('fixPullRequests'),
  threadReplies:form.has('threadRepliesConfigured')?form.has('threadReplies'):defaults.threadReplies,
  securityScan:form.has('securityScanConfigured')?form.has('securityScan'):defaults.securityScan,
 };
}
