/* Comment batches from smapiexporter (comments_*.json): [{ caseId, comments: [...] }], each
with the case's full comment list.
  - smwb.comments: one document per comment (_id = OTSM comment Id), with caseId, times,
    submitter ("First Last"), from/to (Agent, User = customer, System), privacy, purpose,
    the HTML body and a plain-text copy. Comments of the case that are no longer in the list
    (deleted in OTSM) are removed.
  - Each comment also gets isIntegration: the submitter is an OTSM integration account
    (name with "_intuser_"), e.g. csotsm_quixy_intuser_... (ValueEdge notes, From blank) or
    csotsm_email_intuser_... ("email too large" notes, From System).
  - The case gets summary fields, so pages don't need to read the comments collection. Newest
    by CreateTime (the case can change after its newest comment); texts cut to SUMMARY_CHARS:
      commentCount
      latestComment, latestCommentTime/By/From/Privacy/Purpose
                                                    any comment (latestComment was OTSM's
                                                    LatestComment_c until 2026-10-15)
      latestCustomerComment/Time/By                 From "User" or "System" (OTSM's "System"
                                                    comment says a customer email was too large
                                                    for a comment and was attached instead)
      latestAgentComment/Time/By/Privacy            From "Agent", written by an engineer: not by an
                                                    integration account, not an OTSM system comment
      latestValueEdgeComment/Time                   From blank, by the ValueEdge integration account
                                                    (csotsm_quixy_intuser_...: "Updated ValueEdge ...")
  - Comments by the FTS integration account (csotsm_fts_intuser_..., "FTS customer details")
    aren't stored at all (Trevor: not needed anywhere), so they count nowhere.
*/
const COMMENTS_COLLECTION = 'comments';
const SUMMARY_CHARS = 500;
const SKIP_SUBMITTER = /csotsm_fts_intuser_/i;     // FTS notes: not stored
const VALUEEDGE_SUBMITTER = /csotsm_quixy_intuser_/i;

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
            isIntegration: /_intuser_/i.test(c.SubmitterName || ''),
        };
    }

    // First n characters (not UTF-16 halves)
    const cut = (t, n) => Array.from(t || '').slice(0, n).join('');

    function summary(docs) {
        const byTime = docs.slice().sort((a, b) => (b.createTime || 0) - (a.createTime || 0));
        const latest = byTime[0];
        const customer = byTime.find(d => d.from === 'User' || d.from === 'System');
        const agent = byTime.find(d => d.from === 'Agent' && !d.isIntegration && !d.isSystem);
        const valueEdge = byTime.find(d => d.from === '' && VALUEEDGE_SUBMITTER.test(d.submitterName));
        return {
            commentCount: docs.length,
            latestComment: latest ? cut(latest.text, SUMMARY_CHARS) : '',
            latestCommentTime: latest ? latest.createTime : null,
            latestCommentBy: latest ? latest.submitterName : '',
            latestCommentFrom: latest ? latest.from : '',
            latestCommentPrivacy: latest ? latest.privacy : '',
            latestCommentPurpose: latest ? latest.purpose : '',
            latestCustomerComment: customer ? cut(customer.text, SUMMARY_CHARS) : '',
            latestCustomerCommentTime: customer ? customer.createTime : null,
            latestCustomerCommentBy: customer ? customer.submitterName : '',
            latestAgentComment: agent ? cut(agent.text, SUMMARY_CHARS) : '',
            latestAgentCommentTime: agent ? agent.createTime : null,
            latestAgentCommentBy: agent ? agent.submitterName : '',
            latestAgentCommentPrivacy: agent ? agent.privacy : '',
            latestValueEdgeComment: valueEdge ? cut(valueEdge.text, SUMMARY_CHARS) : '',
            latestValueEdgeCommentTime: valueEdge ? valueEdge.createTime : null,
        };
    }

    // Recomputes isIntegration and the case summaries from the stored comments (after a
    // change to these rules), without fetching anything from OTSM.
    async function recomputeAll() {
        const client = new MongoClient(config.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
        try {
            await client.connect();
            const db = client.db(config.MONGO_DB);
            const comments = db.collection(COMMENTS_COLLECTION), cases = db.collection(casesCollection);
            const dropped = await comments.deleteMany({ submitterName: SKIP_SUBMITTER });
            logger.info(`Comments: removed ${dropped.deletedCount} FTS notes.`);
            await comments.updateMany({}, [{ $set: { isIntegration: { $regexMatch: { input: '$submitterName', regex: '_intuser_', options: 'i' } } } }]);
            const caseIds = await comments.distinct('caseId');
            let ops = [], n = 0;
            for (const caseId of caseIds) {
                const docs = await comments.find({ caseId }).toArray();
                ops.push({ updateOne: { filter: { _id: caseId }, update: { $set: summary(docs) } } });
                if (ops.length === 500) { n += (await cases.bulkWrite(ops, { ordered: false })).nMatched; ops = []; }
            }
            if (ops.length) n += (await cases.bulkWrite(ops, { ordered: false })).nMatched;
            // Cases that had comments but have none left (e.g. only FTS notes): empty summary
            const emptied = await cases.updateMany({ commentCount: { $gt: 0 }, _id: { $nin: caseIds } }, { $set: summary([]) });
            logger.info(`Comments: recomputed summaries for ${caseIds.length} cases (${n} matched); ${emptied.modifiedCount} cases left without comments.`);
            return caseIds.length;
        } finally {
            await client.close();
        }
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
                const docs = (entry.comments || []).filter(c => !SKIP_SUBMITTER.test(c.SubmitterName || '')).map(c => toDoc(entry.caseId, c, logTime));
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

    return { store, recomputeAll };
}

module.exports = { createCommentStore };
