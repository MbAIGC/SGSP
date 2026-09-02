/**
 * 轻量事件总线(零依赖)。
 * 用于同步层与 UI/通知层解耦,订阅者异常不向上传播。
 */

export function createEventBus() {
  const handlers = {};

  return {
    on(name, fn) {
      if (!handlers[name]) handlers[name] = [];
      handlers[name].push(fn);
      return this;
    },
    off(name, fn) {
      const list = handlers[name];
      if (list) {
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i] === fn) list.splice(i, 1);
        }
      }
      return this;
    },
    emit(name, payload) {
      const list = handlers[name] || [];
      for (let i = 0; i < list.length; i++) {
        try {
          list[i](payload);
        } catch (e) {
          /* 订阅者异常不影响发布方 */
        }
      }
      return this;
    },
  };
}
