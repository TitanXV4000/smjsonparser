/* Comment batches from smapiexporter (comments_*.json): [{ caseId, comments: [...] }], each
with the case's full comment list.
  - smwb.comments: one document per comment (_id = OTSM comment Id), with caseId, times,
    submitter ("First Last"), from/to (Agent, User = customer, System), privacy, purpose,
    the HTML body and a plain-text copy. Comments of the case that are no longer in the list
    (deleted in OTSM) are removed.
  - The case gets summary fields, so pages don't need to read the comments collection:
    commentCount, latestCommentTime/By/From/Privacy/Purpose (newest comment of any kind, by
    CreateTime: the case can change after its newest comment) and latestCustomerComment,
    latestCustomerCommentTime/By (newest comment with CommentFrom "User").
*/
const COMMENTS_COLLECTION = 'comments';

function createCommentStore({ MongoClient, config, logger, decodeEntities, lastFirstToFirstLast, toDate, casesCollection }) {
    let indexed = false;

    // HTML body -> plain text with line breaks
    function plainText(html) {
        const text = String(html || '')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(p|div|li|tr|h[1-6]|pre|blockquote)>/gi, '\n')
            .replace(/<li[^>]*>/gi, '- ')
            .replace(/<img[^>]*>/gi, '[image]')          // OTSM attachments need a login
            .replace(/<[^>]*>/g, '');
        return decodeEntities(text).replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    function toDoc(caseId, c, logTime) {
        return {
            _id: String(c.Id), caseId: String(caseId), logTime: logTime,
            createTime: toDate(c.CreateTime), updateTime: c.UpdateTime ? toDate(c.UpdateTime) : null,
            submitterId: c.SubmitterId || '', submitterName: lastFirstToFirstLast(c.SubmitterName || ''),
            from: c.CommentFrom || '', to: c.CommentTo || '', privacy: c.PrivacyType || '',
            purpose: c.FunctionalPurpose || '', isSystem: !!c.IsSystem, media: c.Media || '',
            interface: c.ActualInterface || '', body: c.Body || '', text: plainText(c.Body),
        };
    }

    function summary(docs) {
        const byTime = docs.slice().sort((a, b) => (b.createTime || 0) - (a.createTime || 0));
        const latest = byTime[0], customer = byTime.find(d => d.from === 'User');
        return {
            commentCount: docs.length,
            latestCommentTime: latest ? latest.createTime : null,
            latestCommentBy: latest ? latest.submitterName : '',
            latestCommentFrom: latest ? latest.from : '',
            latestCommentPrivacy: latest ? latest.privacy : '',
            latestCommentPurpose: latest ? latest.purpose : '',
            latestCustomerComment: customer ? customer.text : '',
            latestCustomerCommentTime: customer ? customer.createTime : null,
            latestCustomerCommentBy: customer ? customer.submitterName : '',
        };
    }

    async function store(entries) {
        const logTime = new Date();
        const client = new MongoClient(config.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
        try {
            await client.connect();
            const db = client.db(config.MONGO_DB);
            const comments = db.collection(COMMENTS_COLLECTION), cases = db.collection(casesCollection);
            if (!indexed) { await comments.createIndex({ caseId: 1, createTime: -1 }); indexed = true; }
            const commentOps = [], caseOps = [];
            let n = 0;
            for (const entry of entries) {
                const docs = (entry.comments || []).map(c => toDoc(entry.caseId, c, logTime));
                n += docs.length;
                commentOps.push({ deleteMany: { filter: { caseId: String(entry.caseId), _id: { $nin: docs.map(d => d._id) } } } });
                for (const d of docs) { const { _id, ...fields } = d; commentOps.push({ updateOne: { filter: { _id }, update: { $set: fields }, upsert: true } }); }
                caseOps.push({ updateOne: { filter: { _id: String(entry.caseId) }, update: { $set: summary(docs) } } });   // no upsert: cases come from case batches
            }
            if (commentOps.length) await comments.bulkWrite(commentOps, { ordered: true });
            const r = caseOps.length ? await cases.bulkWrite(caseOps, { ordered: false }) : {};
            logger.info(`Comments: ${n} comments for ${entries.length} cases; case summaries updated on ${r.nMatched !== undefined ? r.nMatched : r.matchedCount}.`);
        } finally {
            await client.close();
        }
    }

    return { store };
}

module.exports = { createCommentStore };
