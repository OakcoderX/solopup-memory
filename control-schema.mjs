/** Reuse SQL compilation on one live connection; never cache rows or approval. */
export const CONTROL_APPLICATION_ID=0x44534d31
export const CONTROL_SCHEMA_SQL='CREATE TABLE control_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),payload TEXT NOT NULL)'
const queries=new WeakMap()
function query(db,sql){
 let statements=queries.get(db)
 if(!statements){statements=new Map();queries.set(db,statements)}
 let statement=statements.get(sql)
 if(!statement){statement=db.prepare(sql);statements.set(sql,statement)}
 return statement
}
export function assertControlSchema(db){
 const version=query(db,'PRAGMA user_version').get().user_version,application=query(db,'PRAGMA application_id').get().application_id
 const rows=query(db,"SELECT name,type,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all()
 if(version!==1||application!==CONTROL_APPLICATION_ID||rows.length!==1||rows[0].name!=='control_state'||rows[0].type!=='table'||rows[0].sql!==CONTROL_SCHEMA_SQL)throw Error('managed-policy-database-schema-mismatch')
}
/** Caller still validates shape, size, identity, withdrawal state and permissions on each read. */
export const readControlStateRows=db=>query(db,'SELECT singleton,payload FROM control_state').all()
