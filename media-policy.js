// 通用网络提示只影响自动画质；手动画质继续按插件的真实格式列表选择。
export function automaticVideo(formats, network = {}, resolution) {
  const bandwidth = Number(network.bandwidthBps);
  const measured = Number.isFinite(bandwidth) && bandwidth > 0;
  const ceiling = network.recentStall || network.constrained ? 480 : measured ? Infinity : 720;
  const budget = measured ? bandwidth * 0.65 : Infinity;
  return formats.find(format => resolution(format) <= ceiling && Number(format.bitrate || 0) <= budget) || formats.at(-1);
}

// 短期复用同一播放器响应，避免音频、视频和字幕紧邻请求重复解析；不缓存拒播或失败。
export function playerCache({ now = Date.now, lifetime = 30000, capacity = 4 } = {}) {
  const entries = new Map();
  return async (key, load, consumer = "metadata") => {
    const previous = entries.get(key);
    if (previous && previous.until > now() && (!previous.settled || !previous.consumers.has(consumer))) {
      previous.consumers.add(consumer); return previous.promise;
    }
    if (previous) entries.delete(key);
    const entry = { until: now() + lifetime, consumers: new Set([consumer]), settled: false };
    entry.promise = Promise.resolve().then(load);
    entries.set(key, entry);
    while (entries.size > capacity) entries.delete(entries.keys().next().value);
    try {
      const value = await entry.promise;
      entry.settled = true;
      if (value.playabilityStatus?.status !== 'OK' && entries.get(key) === entry) entries.delete(key);
      return value;
    } catch (error) {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    }
  };
}
