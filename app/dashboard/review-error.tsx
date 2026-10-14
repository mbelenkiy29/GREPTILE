/** Keep the original validation diagnostic available without making it the recovery instruction. */
export function ReviewError({error,alert=false}:{error:string;alert?:boolean}) {
 let summary:string|undefined;
 try {
  const issues:unknown=JSON.parse(error);
  if(Array.isArray(issues)&&issues.length>0&&issues.every(issue=>issue&&typeof issue==='object'&&typeof issue.message==='string'&&typeof issue.code==='string'&&Array.isArray(issue.path))) {
   summary=issues.some(issue=>issue.message.startsWith('No test execution evidence was supplied.'))
    ? 'The generated text claimed a test outcome without recorded execution evidence. OpenReview rejected that output. Re-review the current PR to try again.'
    : 'The generated review did not pass output validation. Inspect the diagnostic below, then re-review the current PR to try again.';
  }
 } catch { /* Provider and runtime errors retain their original readable message. */ }
 if(!summary)return <span role={alert?'alert':undefined} className={alert?'error':undefined}>{error}</span>;
 return <div><p role={alert?'alert':undefined} className={alert?'error':undefined}>{summary}</p><details><summary>Validation diagnostic</summary><pre>{error}</pre></details></div>;
}
