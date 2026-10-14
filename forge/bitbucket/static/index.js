import {invokeRemote} from "@forge/bridge";
import {connectWorkspace,linkPersonalIdentity} from "./connection";
const form=document.querySelector("#connect"),code=document.querySelector("#code"),button=form?.querySelector("button"),status=document.querySelector("#status");
form?.addEventListener("submit",async event=>{
 event.preventDefault();if(button.disabled)return;
 button.disabled=true;status.textContent="Verifying workspace connection…";
 try{
  const result=await connectWorkspace(invokeRemote,code.value.trim());
  status.textContent=result.status==="suspended"?"Workspace connected. Reviews remain suspended until a signed event and scheduled token renewal arrive, then an OpenReview administrator activates this installation.":"Workspace connected. Select repositories in OpenReview.";
 }catch{status.textContent="Connection failed. Open this page in Bitbucket workspace settings, check workspace owner access and create a fresh authorization code in OpenReview.";}
 finally{code.value="";button.disabled=false;}
});

const personalForm=document.querySelector("#personal"),personalCode=document.querySelector("#personal-code"),personalButton=personalForm?.querySelector("button"),personalStatus=document.querySelector("#personal-status");
personalForm?.addEventListener("submit",async event=>{
 event.preventDefault();if(personalButton.disabled)return;personalButton.disabled=true;personalStatus.textContent="Verifying your native account and repository access…";
 try{const result=await linkPersonalIdentity(invokeRemote,personalCode.value.trim());personalStatus.textContent="Identity linked until "+new Date(result.expiresAt).toLocaleString()+". Return to OpenReview and refresh Personal setup.";}catch{personalStatus.textContent="Confirmation failed. Check your signed-in account and repository access, then generate a fresh personal code in OpenReview.";}finally{personalCode.value="";personalButton.disabled=false;}
});
