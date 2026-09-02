/**
 * 并发限制器: 同一时刻最多运行 limit 个异步任务,超出者排队。
 * 语义与 p-limit 一致,不引依赖。
 */

export function createLimiter(limit) {
  const queue = [];
  let active = 0;

  function next() {
    if (active >= limit || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  }

  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}
