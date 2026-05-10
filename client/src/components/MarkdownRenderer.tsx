import React from 'react';

// ===== 最简单的行内渲染器 =====
// 版本：v2 — 已修复 MD 渲染问题
// 不依赖外部库，只处理最常用的格式

interface Props {
  content: string;
  className?: string;
}

function simpleRender(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const out: React.ReactNode[] = [];
  let key = 0;
  let i = 0;
  let inBlock = false;
  let blockBuf: string[] = [];

  while (i < lines.length) {
    const raw = lines[i];
    const trim = raw.trim();

    // 代码块
    if (trim.startsWith('```')) {
      if (inBlock) {
        out.push(
          <pre key={key++} style={{background:'#0d1117',border:'1px solid #30363d',borderRadius:6,padding:12,margin:'6px 0',overflow:'auto'}}>
            <code style={{fontFamily:'monospace',fontSize:'0.85em',color:'#e6edf3',whiteSpace:'pre'}}>{blockBuf.join('\n')}</code>
          </pre>
        );
        blockBuf = [];
        inBlock = false;
      } else {
        inBlock = true;
      }
      i++;
      continue;
    }
    if (inBlock) {
      blockBuf.push(raw);
      i++;
      continue;
    }

    // 空行
    if (trim === '') { i++; continue; }

    // 标题
    const hd = trim.match(/^(#{1,6})\s+(.+)/);
    if (hd) {
      const level = hd[1].length;
      const sz = [28,24,20,18,16,14][level-1];
      out.push(
        <div key={key++} style={{fontSize:sz,fontWeight:600,margin:'10px 0 4px',color:'#e6edf3'}}>
          {hd[2]}
        </div>
      );
      i++; continue;
    }

    // 引用
    if (trim.startsWith('> ')) {
      out.push(
        <div key={key++} style={{padding:'4px 12px',margin:'6px 0',borderLeft:'3px solid #58a6ff',background:'rgba(56,139,253,0.05)',borderRadius:4,color:'#8b949e'}}>
          {trim.slice(2)}
        </div>
      );
      i++; continue;
    }

    // 分割线
    if (/^[-*_]{3,}$/.test(trim)) {
      out.push(<hr key={key++} style={{border:'none',borderTop:'1px solid #30363d',margin:'10px 0'}} />);
      i++; continue;
    }

    // 无序列表
    const ul = trim.match(/^[-*+]\s+(.+)/);
    if (ul) {
      const items: React.ReactNode[] = [ul[1]];
      i++;
      while (i < lines.length) {
        const m = lines[i].match(/^[-*+]\s+(.+)/);
        if (!m) break;
        items.push(m[1]);
        i++;
      }
      out.push(
        <ul key={key++} style={{margin:'4px 0',paddingLeft:24,color:'#e6edf3'}}>
          {items.map((x,idx) => <li key={idx} style={{marginBottom:2}}>{x}</li>)}
        </ul>
      );
      continue;
    }

    // 有序列表
    const ol = trim.match(/^\d+\.\s+(.+)/);
    if (ol) {
      const items: React.ReactNode[] = [ol[1]];
      i++;
      while (i < lines.length) {
        const m = lines[i].match(/^\d+\.\s+(.+)/);
        if (!m) break;
        items.push(m[1]);
        i++;
      }
      out.push(
        <ol key={key++} style={{margin:'4px 0',paddingLeft:24,color:'#e6edf3'}}>
          {items.map((x,idx) => <li key={idx} style={{marginBottom:2}}>{x}</li>)}
        </ol>
      );
      continue;
    }

    // 行内格式处理
    let processed = raw;
    // 加粗 **text**
    processed = processed.replace(/\*\*(.+?)\*\*/g, '<b style="color:#e6edf3">$1</b>');
    // 斜体 *text*
    processed = processed.replace(/\*(.+?)\*/g, '<i>$1</i>');
    // 行内代码
    processed = processed.replace(/`(.+?)`/g, '<code style="background:rgba(56,139,253,0.1);padding:1px 4px;border-radius:3px;font-size:0.9em;color:#58a6ff">$1</code>');
    // 链接
    processed = processed.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" style="color:#58a6ff">$1</a>');

    // 普通段落（可能会跨多行）
    const paraTexts: string[] = [processed];
    i++;
    while (i < lines.length) {
      const nl = lines[i].trim();
      if (nl === '' || /^#{1,6}\s/.test(nl) || /^[-*+]\s/.test(nl) || /^\d+\.\s/.test(nl) || nl.startsWith('```') || nl.startsWith('> ')) break;
      paraTexts.push(lines[i]);
      i++;
    }

    out.push(
      <p key={key++} style={{marginBottom:6,lineHeight:1.6,color:'#e6edf3',whiteSpace:'pre-wrap'}}>
        <span dangerouslySetInnerHTML={{__html: paraTexts.join('<br/>')}} />
      </p>
    );
  }

  return out;
}

export default function MarkdownRenderer({ content, className = '' }: Props) {
  try {
    const elements = React.useMemo(() => simpleRender(content || ''), [content]);
    return <div className={className}>{elements}</div>;
  } catch (e) {
    // 即使渲染崩了，也显示纯文本，不让整个面板白屏
    return <div className={className} style={{color:'#e6edf3',whiteSpace:'pre-wrap'}}>{content}</div>;
  }
}