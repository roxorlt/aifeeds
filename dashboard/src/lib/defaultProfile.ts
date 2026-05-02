// 默认 profile 兜底：user.display_name 为 null 时前端基于 user.id 派生稳定昵称 / 头像字。

const NICKNAME_POOL = [
  '数字游民', '夜猫子', '冲浪选手', '产品猎人', '探险家', '观察者',
  '思考者', '设计师', '工程师', '创作者', '收藏家', '行者',
  '匠人', '诗人', '观星人', '潜水员', '飞行员', '攀登者',
  '骑手', '航海家', '极客', '咖啡因', '云游者', '听风者',
  '拾荒者', '种树人', '记录者', '编织者', '远行者', '守夜人',
  '逐光人', '解谜人',
] as const;

// 简单 djb2 hash，稳定不依赖 Web Crypto
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) + s.charCodeAt(i);
    h = h | 0; // force int32
  }
  return Math.abs(h);
}

export function defaultNickname(userId: string): string {
  const h = hash(userId);
  const word = NICKNAME_POOL[h % NICKNAME_POOL.length];
  const num = (h % 9000) + 1000;  // 4 位数字
  return `${word}${num}`;
}

export function displayNameOf(user: { id: string; display_name: string | null }): string {
  return user.display_name?.trim() || defaultNickname(user.id);
}
