import {z} from 'zod';
export const changeMetadataSchema=z.object({number:z.number().int().positive().safe(),title:z.string(),html_url:z.string().url().refine(s=>{const u=new URL(s);return ["https:","http:"].includes(u.protocol)&&!u.username&&!u.password;},"Invalid change source URL"),state:z.string(),draft:z.boolean(),user:z.object({login:z.string()}),head:z.object({sha:z.string().min(1),ref:z.string()}),base:z.object({sha:z.string().min(1),ref:z.string()}),revisionKey:z.string().optional()});
export type ChangeMetadata=z.infer<typeof changeMetadataSchema>;
export type ChangePage={numbers:number[];next:string|null};
export const catalogPageSize=30;
export function numberedPage(cursor:string|null,first=1){if(cursor===null)return first;if(!/^(0|[1-9][0-9]*)$/.test(cursor)||!Number.isSafeInteger(Number(cursor))||Number(cursor)<first)throw new Error('Invalid change catalog cursor');return Number(cursor);}
export function validateChangePage(page:ChangePage,current:string|null):ChangePage{
 if(page.numbers.length>catalogPageSize||page.numbers.some(n=>!Number.isSafeInteger(n)||n<1)||new Set(page.numbers).size!==page.numbers.length||page.next!==null&&(!page.next||page.next.length>2000||page.next===current||!page.numbers.length))throw new Error('Invalid or repeated change catalog page');
 return page;
}
