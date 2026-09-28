const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');

const rows=[];
const receipts=new Map();
const settingCode='3194'; // Test fixture only; the live code stays in the private sheet.
const settings={getRange(address){
  assert.equal(address,'B2');
  return {getDisplayValue:()=>settingCode};
}};
const sheet={
  getLastRow:()=>rows.length,
  setFrozenRows:()=>{},
  getRange(start,column,height,width){
    return {
      setValues(values){
        for(let i=0;i<values.length;i++){
          if(!rows[start+i-1])rows[start+i-1]=[];
          for(let j=0;j<width;j++)rows[start+i-1][column+j-1]=values[i][j];
        }
      },
      getValues(){return Array.from({length:height},(_,i)=>
        rows[start+i-1].slice(column-1,column-1+width));},
    };
  },
  deleteRow(index){rows.splice(index-1,1);},
};
const context={
  ContentService:{MimeType:{JSON:'json',JAVASCRIPT:'js'},createTextOutput(text){
    return {text,setMimeType(type){this.type=type;return this;}};
  }},
  SpreadsheetApp:{getActiveSpreadsheet:()=>({
    getSheetByName:name=>name==='Settings'?settings:rows.length?sheet:null,
    insertSheet:()=>sheet,
  })},
  CacheService:{getScriptCache:()=>({
    get:key=>receipts.get(key)||null,
    put:(key,value)=>receipts.set(key,value),
  })},
  LockService:{getScriptLock:()=>({waitLock(){},releaseLock(){}})},
  Utilities:{DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(_,value)=>
    [...crypto.createHash('sha256').update(value).digest()]},
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('apps-script/Code.gs','utf8'),context);

const callback='lineageCallback_'+'a'.repeat(32);
const id='b'.repeat(32);
function post(action,password,other={}){
  return JSON.parse(context.doPost({parameter:{action,password,opId:'c'.repeat(32),...other}}).text);
}
function get(action,other={}){
  const output=context.doGet({parameter:{action,callback,...other}});
  assert.equal(output.type,'js');
  return JSON.parse(output.text.slice(callback.length+1,-2));
}

assert.equal(get('list').landmarks.length,0);
assert.equal(post('save','incorrect',{id,name:'Test',x:'2',y:'3',row:'1',col:'2'}).ok,false);
assert.equal(rows.length,1);
assert.equal(post('verify',settingCode).ok,true);
assert.equal(post('save',settingCode,{id,name:'=Test',type:'place',note:'Note',x:'2',y:'3',row:'1',col:'2'}).ok,true);
assert.equal(get('list').landmarks.length,1);
assert.equal(rows[1][1],"'=Test");
for(const [type,testId] of [['boss','d'.repeat(32)],['note','e'.repeat(32)]]){
  assert.equal(post('save',settingCode,{id:testId,name:type,type,x:'2',y:'3',row:'1',col:'2'}).ok,true);
  assert.equal(get('list').landmarks.find(item=>item.id===testId).type,type);
}
assert.equal(get('receipt',{id:'c'.repeat(32)}).ok,true);
assert.equal(post('delete','incorrect',{id}).ok,false);
assert.equal(get('list').landmarks.length,3);
assert.equal(post('delete',settingCode,{id}).ok,true);
assert.equal(get('list').landmarks.length,2);
console.log('Landmark backend: password guard, save, public list, receipt, and delete passed');
