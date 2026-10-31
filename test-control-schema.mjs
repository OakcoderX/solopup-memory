import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {CONTROL_APPLICATION_ID,CONTROL_SCHEMA_SQL,assertControlSchema,readControlStateRows} from './control-schema.mjs'
const setup=db=>db.exec(CONTROL_SCHEMA_SQL+'; PRAGMA application_id='+CONTROL_APPLICATION_ID+'; PRAGMA user_version=1;')
const box=run=>{const db=new DatabaseSync(':memory:');try{setup(db);run(db)}finally{db.close()}}
test('one live connection reads newly added and removed schema rows rather than a cached approval',()=>box(db=>{
 assertControlSchema(db);db.exec('CREATE TABLE unexpected(payload TEXT)');assert.throws(()=>assertControlSchema(db),/schema-mismatch/)
 db.exec('DROP TABLE unexpected');assertControlSchema(db)
}))
test('extra indexes are detected after the same compiled schema query has already succeeded',()=>box(db=>{
 assertControlSchema(db);db.exec('CREATE INDEX unexpected ON control_state(payload)');assert.throws(()=>assertControlSchema(db),/schema-mismatch/)
 db.exec('DROP INDEX unexpected');assertControlSchema(db)
}))
for(const pragma of ['user_version','application_id'])test('changed '+pragma+' is checked again on the same connection',()=>box(db=>{
 assertControlSchema(db);db.exec('PRAGMA '+pragma+'=7');assert.throws(()=>assertControlSchema(db),/schema-mismatch/)
 db.exec('PRAGMA '+pragma+'='+(pragma==='user_version'?1:CONTROL_APPLICATION_ID));assertControlSchema(db)
}))
test('a different connection does not inherit the previous connection approval',()=>box(first=>{
 assertControlSchema(first);const other=new DatabaseSync(':memory:');try{assert.throws(()=>assertControlSchema(other),/schema-mismatch/)}finally{other.close()}
}))
test('payload updates and deletion remain visible through the same compiled query',()=>box(db=>{
 assert.deepEqual(readControlStateRows(db),[]);db.prepare('INSERT INTO control_state(singleton,payload) VALUES(1,?)').run('{"revision":1}')
 assert.equal(readControlStateRows(db)[0].payload,'{"revision":1}');db.exec("UPDATE control_state SET payload='{\"revision\":2}'")
 assert.equal(readControlStateRows(db)[0].payload,'{"revision":2}');db.exec('DELETE FROM control_state');assert.deepEqual(readControlStateRows(db),[])
}))
