// 首字母圆形头像 placeholder
// PR3 用：UserMenu / Settings / DeleteAccountConfirm
// 未来支持上传时（PR5+），传 src 优先用 src

interface Props {
  name?: string | null;             // 取首字母（中文取首字、英文取大写首字母）
  phoneMasked?: string | null;      // 兜底：name 缺失时取 phoneMasked 倒二位
  src?: string | null;
  size?: number;                    // px
  className?: string;
}

export function AvatarPlaceholder({ name, phoneMasked, src, size = 36, className }: Props) {
  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        className={`rounded-full object-cover ${className ?? ''}`}
      />
    );
  }
  let letter = '?';
  if (name && name.length > 0) {
    letter = name.trim().charAt(0).toUpperCase();
  } else if (phoneMasked && phoneMasked.length >= 4) {
    letter = phoneMasked.slice(-2, -1);
  }
  const code = letter.charCodeAt(0);
  const palette = [
    'bg-rose-500', 'bg-pink-500', 'bg-fuchsia-500', 'bg-purple-500',
    'bg-violet-500', 'bg-indigo-500', 'bg-blue-500', 'bg-sky-500',
    'bg-cyan-500', 'bg-teal-500', 'bg-emerald-500', 'bg-green-500',
    'bg-lime-600', 'bg-amber-600', 'bg-orange-500', 'bg-red-500',
  ];
  const bg = palette[code % palette.length];
  return (
    <div
      className={`flex items-center justify-center rounded-full text-white font-semibold ${bg} ${className ?? ''}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {letter}
    </div>
  );
}
