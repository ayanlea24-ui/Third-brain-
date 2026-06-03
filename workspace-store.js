'use strict';

/** Client-side API injected into workspace pages (MongoDB via /api/board-store). */
function buildWorkspaceStoreApiJs() {
  return (
    'var _wsTimers={};' +
    'function wsReadLocalOnce(key){try{var w=localStorage.getItem(key);if(w==null)return null;return JSON.parse(w);}catch(e){return null;}}' +
    'function wsPut(key,payload){if(_wsTimers[key])clearTimeout(_wsTimers[key]);_wsTimers[key]=setTimeout(function(){fetch("/api/board-store/"+encodeURIComponent(key),{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({payload:payload})}).then(function(r){if(!r.ok)throw new Error("save failed");return r.json();}).then(function(){console.log("[Third brain] saved to database:",key);}).catch(function(e){console.warn("[Third brain] database save failed:",key,e);});},350);}' +
    'function wsGet(key,cb){fetch("/api/board-store/"+encodeURIComponent(key),{headers:{Accept:"application/json"}}).then(function(r){if(!r.ok)throw new Error("get failed");return r.json();}).then(function(res){var data=res&&Object.prototype.hasOwnProperty.call(res,"payload")?res.payload:null;if(data==null){var loc=wsReadLocalOnce(key);if(loc!=null){wsPut(key,loc);cb(null,loc);return;}cb(null,null);return;}cb(null,data);}).catch(function(err){var loc=wsReadLocalOnce(key);cb(err,loc!=null?loc:null);});}'
  );
}

module.exports = { buildWorkspaceStoreApiJs };
