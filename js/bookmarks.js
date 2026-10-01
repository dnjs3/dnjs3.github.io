"use strict";

const BOOKMARKS = [
  { title:"MDN Web Docs", url:"https://developer.mozilla.org/", category:"개발 문서", description:"HTML, CSS, JavaScript를 확인할 때 가장 먼저 찾는 웹 표준 문서.", tags:["web","reference"] },
  { title:"web.dev", url:"https://web.dev/", category:"프론트엔드", description:"성능, 접근성, 브라우저 기능을 예제와 함께 정리한 학습 자료.", tags:["performance","frontend"] },
  { title:"JavaScript.info", url:"https://javascript.info/", category:"JavaScript", description:"기초 문법부터 브라우저 내부 동작까지 차근차근 읽기 좋은 튜토리얼.", tags:["javascript","tutorial"] },
  { title:"roadmap.sh", url:"https://roadmap.sh/", category:"로드맵", description:"직무와 기술별 학습 순서를 한눈에 확인할 수 있는 개발 로드맵.", tags:["roadmap","career"] },
  { title:"GitHub", url:"https://github.com/", category:"도구", description:"코드와 프로젝트를 살펴보고, 구현 아이디어를 기록하는 공간.", tags:["code","opensource"] },
  { title:"Stack Overflow", url:"https://stackoverflow.com/", category:"문제 해결", description:"막힌 문제의 실마리를 찾고 다양한 해결 방식을 비교할 때 참고하는 곳.", tags:["debug","community"] },
];

const grid = document.getElementById("bookmark-grid");
const filter = document.getElementById("category-filter");
const search = document.getElementById("bookmark-search");
const count = document.getElementById("visible-count");
const empty = document.getElementById("empty-message");
let activeCategory = "전체";

function cardFor(item){
  const link=document.createElement("a"); link.className="bookmark-card"; link.href=item.url; link.target="_blank"; link.rel="noopener noreferrer";
  const top=document.createElement("div"); top.className="card-top";
  const mark=document.createElement("span"); mark.className="site-mark"; mark.textContent=item.title.slice(0,1).toUpperCase();
  const arrow=document.createElement("span"); arrow.className="external-arrow"; arrow.textContent="↗"; top.append(mark,arrow);
  const title=document.createElement("h3"); title.textContent=item.title;
  const description=document.createElement("p"); description.textContent=item.description;
  const tags=document.createElement("div"); tags.className="tag-row"; item.tags.forEach(tag=>{const span=document.createElement("span");span.textContent=tag;tags.append(span)});
  link.append(top,title,description,tags); return link;
}
function render(){
  const query=search.value.trim().toLocaleLowerCase("ko-KR");
  const items=BOOKMARKS.filter(item=>(activeCategory==="전체"||item.category===activeCategory)&&(!query||[item.title,item.description,item.category,...item.tags].join(" ").toLocaleLowerCase("ko-KR").includes(query)));
  grid.replaceChildren(...items.map(cardFor)); count.textContent=String(items.length); empty.hidden=items.length>0;
}
function renderFilters(){
  const categories=["전체",...new Set(BOOKMARKS.map(item=>item.category))];
  filter.replaceChildren(...categories.map(category=>{const button=document.createElement("button");button.type="button";button.className=`filter-button${category===activeCategory?" active":""}`;button.textContent=category;button.addEventListener("click",()=>{activeCategory=category;renderFilters();render()});return button}));
}
search.addEventListener("input",render);
document.addEventListener("keydown",event=>{if(event.key==="/"&&document.activeElement!==search){event.preventDefault();search.focus()}});
renderFilters(); render();
