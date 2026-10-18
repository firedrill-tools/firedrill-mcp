import { FiredrillError } from "./errors.js";
/** Exact IDs make an interrupted acknowledgement safe to replay, never a target retry. */
export async function flushLiveEvents(work, save, append) {
    while (work.liveEvents?.length) {
        const page = work.liveEvents.slice(0, 16);
        await append(page);
        work.liveEvents.splice(0, page.length);
        if (!work.liveEvents.length)
            delete work.liveEvents;
        save();
    }
}
/** observe() stays synchronous: durable local intent first, bounded asynchronous delivery. */
export function liveEvents(work, save, append) {
    let draining, stopped = false, closed = false;
    const start = () => {
        if (draining || stopped || closed)
            return;
        draining = flushLiveEvents(work, save, append).catch(() => {
            // The original event remains in the journal. Finalization/recovery retries
            // the same ID; a delivery failure is not evidence that the target failed.
            stopped = true;
        }).finally(() => { draining = undefined; if (work.liveEvents?.length)
            start(); });
    };
    return {
        record(value) {
            if (closed)
                throw new FiredrillError("OBSERVATION_CLOSED", "The invocation has already returned.", "Await all target observations before returning.");
            if ((work.liveEvents?.length ?? 0) >= 10000)
                throw new FiredrillError("OBSERVATION_LIMIT", "Pending live observations reached their event bound.", "Use compact observations and retain larger evidence as attachments.");
            (work.liveEvents ??= []).push(value);
            save();
            start();
        },
        async settle() { closed = true; await draining; },
    };
}
