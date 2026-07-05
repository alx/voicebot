/**
 * Creates a simple FIFO queue that runs one async task at a time.
 * @returns {{ enqueue: (task: () => Promise<any>) => Promise<any> }}
 */
export function createQueue() {
    let tail = Promise.resolve();

    function enqueue(task) {
        const result = tail.then(() => task());
        // Swallow errors in the chain so one failed task doesn't block the next
        tail = result.catch(() => {});
        return result;
    }

    return { enqueue };
}
