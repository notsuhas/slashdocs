import { BRIDGE_JS } from "../../shared/bridge.generated";

function attribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&#39;");
}
const BRIDGE_PRELUDE =
  '<script id="slashdocs-bootstrap">(function(){if(window.slashdocs&&window.slashdocs.kv&&window.slashdocs.github&&window.slashdocs.github.connect)return;var q=[],gq=[],handlers={kvchange:[]};function enqueue(op,args){return new Promise(function(resolve,reject){q.push({op:op,args:Array.prototype.slice.call(args),resolve:resolve,reject:reject});});}function github(input){return new Promise(function(resolve,reject){gq.push({input:input,resolve:resolve,reject:reject});});}function githubConnect(){window.__slashdocsGitHubConnectQueued=true;}function off(event,handler){if(event!=="kvchange")return;handlers.kvchange=handlers.kvchange.filter(function(h){return h!==handler;});}function on(event,handler){if(event==="kvchange"&&typeof handler==="function"){handlers.kvchange.push(handler);return function(){off(event,handler);};}}window.__slashdocsKVQueue=q;window.__slashdocsGitHubQueue=gq;window.__slashdocsKVHandlers=handlers;window.slashdocs=window.aidocs=Object.assign(window.slashdocs||{},{kv:{get:function(){return enqueue("get",arguments);},all:function(){return enqueue("all",arguments);},set:function(){return enqueue("set",arguments);},delete:function(){return enqueue("delete",arguments);},patch:function(){return enqueue("patch",arguments);},undo:function(){return enqueue("undo",arguments);},redo:function(){return enqueue("redo",arguments);}},github:{getRawContent:github,connect:githubConnect},on:on,off:off});})();</script>';

export function userHTMLWithBridgePrelude(html: string): string {
  for (const tag of ["head", "html"]) {
    const match = new RegExp("<" + tag + "(?=[\\s/>])[^>]*>", "i").exec(html);
    if (match) {
      const end = match.index + match[0].length;
      return html.slice(0, end) + BRIDGE_PRELUDE + html.slice(end);
    }
  }
  const doctype = /<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    const end = doctype.index + doctype[0].length;
    return html.slice(0, end) + BRIDGE_PRELUDE + html.slice(end);
  }
  return BRIDGE_PRELUDE + html;
}

function printableHTML(html: string): string {
  const bootstrap =
    '<style id="slashdocs-print-style">[data-slashdocs-comment-id],.slashdocs-comment-highlight{background:transparent!important;box-shadow:none!important}@media print{html,body{overflow:visible!important;height:auto!important}}</style><script id="slashdocs-print-bootstrap">addEventListener("load",function(){setTimeout(function(){window.print()},150)},{once:true});</script>';
  const closing = html.toLowerCase().lastIndexOf("</body>");
  return closing >= 0
    ? html.slice(0, closing) + bootstrap + html.slice(closing)
    : html + bootstrap;
}

export function renderWrapperHTML(
  html: string,
  appOrigin: string,
  print = false,
): string {
  const source = userHTMLWithBridgePrelude(print ? printableHTML(html) : html);
  const origin = JSON.stringify(appOrigin)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
  return `<!doctype html><html><head><meta charset="utf-8"><title>slashdocs render</title><style>html,body{margin:0;height:100%;overflow:hidden}#slashdocs-doc{border:0;width:100%;height:100vh}</style><script>try{var u=new URL(location.href);if(u.searchParams.has("token")){u.searchParams.delete("token");history.replaceState(null,"",u.pathname+(u.search||"")+u.hash)}}catch(e){}</script></head><body><iframe id="slashdocs-doc" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcdoc="${attribute(source)}"></iframe><script>window.__SLASHDOCS_APP_ORIGIN__=${origin};${BRIDGE_JS}</script></body></html>`;
}
