/* Case event log (smwb.events), for the server-side board: history ("taken by",
"moved to another product"), time in queue and stats.
Before a batch of cases is written, the stored values of the tracked fields are compared
with the incoming ones; each difference becomes one event:
  { caseId, field, from, to, time, seen, by }
    time  when OTSM recorded the change: the case's updatedOn (falls back to seen)
    seen  when the parser saw it (logTime)
    by    lastUpdatedByName of the incoming case
A case the parser hasn't stored before gets a "created" event (time = createdOn). Within a
batch, values are tracked in order, so a case listed twice is compared with its previous row.
*/
const EVENTS_COLLECTION = 'events';
const TRACKED = ['ownerName', 'statusId', 'priorityId', 'product', 'productModel', 'assignmentGroupName',
    'title', 'caseTypeId', 'phaseId'];

function createEventLog({ logger }) {
    let indexed = false;
    const norm = v => (v === undefined || v === null) ? '' : String(v);

    async function record(db, casesCollection, docs) {
        if (!docs.length) return 0;
        const events = db.collection(EVENTS_COLLECTION);
        if (!indexed) {
            await events.createIndex({ caseId: 1, time: 1 });
            await events.createIndex({ time: 1, field: 1 });
            indexed = true;
        }
        const projection = {};
        TRACKED.forEach(f => projection[f] = 1);
        projection.updatedOn = 1;
        const ids = [...new Set(docs.map(d => d._id))];
        const stored = new Map();
        for (let i = 0; i < ids.length; i += 1000) {
            const found = await db.collection(casesCollection).find({ _id: { $in: ids.slice(i, i + 1000) } }, { projection }).toArray();
            found.forEach(d => stored.set(d._id, d));
        }
        const out = [];
        for (const doc of docs) {
            const before = stored.get(doc._id);
            const time = doc.updatedOn instanceof Date ? doc.updatedOn : doc.logTime;
            if (!before) {
                out.push({ caseId: doc._id, field: 'created', from: '', to: norm(doc.ownerName),
                    time: doc.createdOn instanceof Date ? doc.createdOn : time, seen: doc.logTime, by: norm(doc.requestedByName) });
            } else {
                for (const f of TRACKED) {
                    if (!(f in doc)) continue;
                    const a = norm(before[f]), b = norm(doc[f]);
                    if (a !== b) out.push({ caseId: doc._id, field: f, from: a, to: b, time, seen: doc.logTime, by: norm(doc.lastUpdatedByName) });
                }
            }
            const next = Object.assign({}, before || {});
            TRACKED.forEach(f => { if (f in doc) next[f] = doc[f]; });
            stored.set(doc._id, next);
        }
        if (out.length) await events.insertMany(out, { ordered: false });
        return out.length;
    }

    return { record };
}

module.exports = { createEventLog };
