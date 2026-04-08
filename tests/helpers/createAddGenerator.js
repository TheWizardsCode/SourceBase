export function createAddGenerator(events = [], result) {
  // Returns an async-generator that yields provided events and returns the result
  return (async function* () {
    for (const e of events) yield e;
    return result;
  })();
}
