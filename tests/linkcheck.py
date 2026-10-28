import sys, re, pathlib
from html.parser import HTMLParser
root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '..')
pages = sorted(root.glob('*.html'))
ids, links, dup = {}, [], []
class P(HTMLParser):
    def __init__(s, name): super().__init__(); s.name=name; s.ids=set()
    def handle_starttag(s, tag, attrs):
        a=dict(attrs)
        if 'id' in a:
            if a['id'] in s.ids: dup.append((s.name,a['id']))
            s.ids.add(a['id'])
        if tag=='a' and 'href' in a: links.append((s.name,a['href']))
        if tag in('link','script') and ('href' in a or 'src' in a):
            links.append((s.name,a.get('href') or a.get('src')))
for p in pages:
    pr=P(p.name); pr.feed(p.read_text()); ids[p.name]=pr.ids
bad=[]
for src,h in links:
    if h.startswith(('http:','https:','mailto:','data:')): continue
    path,_,frag = h.partition('#'); path=path.split('?')[0]
    target = path or src
    if not (root/target).exists(): bad.append((src,h,'missing file')); continue
    if frag and target.endswith('.html') and frag not in ids.get(target,set()): bad.append((src,h,'missing anchor'))
print(f'pages={len(pages)} links_checked={len(links)} broken={len(bad)} duplicate_ids={len(dup)}')
for b in bad: print('BROKEN',b)
for d in dup: print('DUP',d)
sys.exit(1 if bad or dup else 0)
