import { memo, useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { api } from "../lib/api";

const schema = {
  ...defaultSchema,
  clobberPrefix: "",
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "align", "id"],
    img: [...(defaultSchema.attributes?.img ?? []), "width", "height", "align"],
  },
};

export interface MarkdownProps {
  text: string;
  onInternalLink?: (href: string) => void;
  resolveImage?: (src: string) => Promise<string | null>;
  className?: string;
}

function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

function LocalImage({
  src,
  alt,
  resolve,
  width,
  height,
}: {
  src: string;
  alt: string;
  resolve?: (src: string) => Promise<string | null>;
  width?: string | number;
  height?: string | number;
}) {
  const [url, setUrl] = useState<string | null>(isExternal(src) && src.startsWith("https://") ? src : null);
  useEffect(() => {
    if (isExternal(src) || !resolve) return;
    let alive = true;
    resolve(src)
      .then((u) => {
        if (alive) setUrl(u);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [src, resolve]);
  if (!url) return <span className="md-img-missing">{alt}</span>;
  return <img src={url} alt={alt} width={width} height={height} loading="lazy" />;
}

export const Markdown = memo(function Markdown({
  text,
  onInternalLink,
  resolveImage,
  className,
}: MarkdownProps) {
  const components: Components = {
    a: ({ href, children, ...rest }) => {
      const target = href ?? "";
      return (
        <a
          {...rest}
          href={target}
          onClick={(e) => {
            e.preventDefault();
            if (!target) return;
            if (target.startsWith("#")) {
              const el = document.getElementById(decodeURIComponent(target.slice(1)));
              el?.scrollIntoView({ behavior: "smooth", block: "start" });
              return;
            }
            if (isExternal(target)) {
              if (target.startsWith("https://") || target.startsWith("http://")) void api.openUrl(target);
              return;
            }
            onInternalLink?.(target);
          }}
        >
          {children}
        </a>
      );
    },
    img: ({ src, alt, width, height }) => (
      <LocalImage
        src={typeof src === "string" ? src : ""}
        alt={alt ?? ""}
        resolve={resolveImage}
        width={width}
        height={height}
      />
    ),
    table: ({ children }) => (
      <div className="md-table">
        <table>{children}</table>
      </div>
    ),
  };
  return (
    <div className={`md${className ? ` ${className}` : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, schema], rehypeSlug]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
