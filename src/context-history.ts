import type {SourceFile} from './engine/types';
/** Prior external evidence can inform a new review only when that exact pinned source was fetched again. */
export function hasCurrentRepositoryEvidence(finding:{evidence:{filePath:string}[]},sources:SourceFile[]){
 const paths=new Set(sources.map(f=>f.path));return finding.evidence.every(e=>!e.filePath.startsWith('context/')||paths.has(e.filePath));
}
