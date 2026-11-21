/**
 * Does this text name the person, and does it name their company?
 *
 * One matcher for the quick brief (founderCheck.js) and the deep check
 * (identity.js), so the two can never drift apart. Pinning a namesake's
 * record on a founder is the worst mistake this tool can make, so every rule
 * here leans towards "not the same" when the text is ambiguous; callers keep
 * such records as "possible" at most.
 *
 * The person's name
 *   accepted as the full name: middle names and initials ("Eric M. Glyman"),
 *   titles and generational suffixes (Dr., Jr., III), accents either way
 *   (Vélez / Velez), a hyphen or a space inside a given name (Jean-Luc / Jean
 *   Luc), "Surname, Given" order, register capitals ("Eric Robert GLYMAN").
 *   weaker kinds, never the full name: the surname with another given name,
 *   initials only ("E. Glyman"), a longer hyphenated surname ("John
 *   Smith-Jones"), a nickname (Bill for William), "Surname Given" without a
 *   comma, a different middle name or suffix.
 *
 * The company
 *   a distinctive name (Theranos, Nikola) counts when it is written as a name.
 *   A name that is an ordinary word (Ramp, Merge, Plaid, Notion, Square, Apple)
 *   counts only when the text uses it as a company: a legal form, its domain or
 *   handle, a learned legal name, a role or a business verb beside it, or a
 *   business word in the same clause. A capital at the start of a sentence or
 *   in a Title Case headline proves nothing.
 *
 * Positions returned here are always in the caller's original text, so a
 * caller can measure how close the name and the company are.
 */

// ---------------------------------------------------------------------------
// Folding: accents, apostrophes and hyphens, keeping a map to the original.
// ---------------------------------------------------------------------------

const FOLD_SPECIAL = { 'ł': 'l', 'Ł': 'L', 'ø': 'o', 'Ø': 'O', 'đ': 'd', 'Đ': 'D', 'ı': 'i', 'ħ': 'h', '’': "'", '‘': "'", 'ʼ': "'", '`': "'", '‐': '-', '‑': '-', '‒': '-' };
const COMBINING = /[̀-ͯ]/;

/**
 * Fold accents and typographic marks, one character for one, and keep where
 * each folded character came from: { text, map } where map[i] is the index in
 * the original of folded character i (map[text.length] is the original length).
 */
export function foldWithMap(input) {
  const s = String(input || '');
  let text = '';
  const map = [];
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (COMBINING.test(c)) continue; // a decomposed accent: dropped, its letter stays
    let f = FOLD_SPECIAL[c];
    if (f === undefined) {
      f = c.normalize('NFD').replace(/[̀-ͯ]/g, '');
      if (f.length !== 1) f = c;
    }
    text += f;
    map.push(i);
  }
  map.push(s.length);
  return { text, map };
}

/** "José García-Vélez" -> "Jose Garcia-Velez" (case kept). */
export const foldAccents = (s) => foldWithMap(s).text;

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lowerFold = (s) => foldAccents(s).toLowerCase();

// ---------------------------------------------------------------------------
// Word lists.
// ---------------------------------------------------------------------------

const words = (s) => new Set(s.trim().split(/\s+/));

const TITLES = words('dr mr mrs ms mx miss prof professor sir dame rev reverend hon honorable lord lady judge');
// Capitalised words that may stand right before a person's name without being their given name.
const NOT_A_GIVEN = words(`monday tuesday wednesday thursday friday saturday sunday january february march april may june july
august september october november december senator governor representative rep mayor ambassador secretary minister
officer detective agent attorney prosecutor defendant plaintiff witness justice commissioner chancellor congressman
congresswoman councilman councilwoman sheriff general captain colonel lieutenant sergeant inventor author editor
reporter host speaker partner trustee dean coach saint san santa`);
const GENERATIONAL = words('jr sr ii iii iv');
const DEGREE_SUFFIX = words('phd md esq mba cpa jd dds qc kc obe cbe mbe frs');
const SURNAME_PARTICLES = words('van von der den de del della di da dos das du la le bin binti ibn al el ben ter ten');

// Very common given names across US, Chinese, Indian, Korean, Hispanic and Arabic naming.
const COMMON_GIVEN = words(`
james john robert michael william david richard joseph thomas charles christopher daniel matthew anthony mark donald
steven stephen paul andrew joshua kenneth kevin brian george timothy ronald edward jason jeffrey ryan jacob gary nicholas
eric jonathan larry justin scott brandon benjamin samuel gregory alexander frank patrick raymond jack dennis jerry tyler
aaron adam nathan henry douglas peter kyle ethan walter noah jeremy christian keith roger terry sean austin carl arthur
lawrence dylan jesse jordan bryan billy bruce gabriel logan albert alan wayne roy vincent ralph eugene russell bobby
philip louis mike bill bob jim tom dave chris steve dan matt tony joe ben sam alex nick jeff greg tim ken
mary patricia jennifer linda elizabeth barbara susan jessica sarah karen lisa nancy betty margaret sandra ashley
kimberly emily donna michelle carol amanda dorothy melissa deborah stephanie rebecca sharon laura cynthia kathleen amy
angela anna brenda pamela emma nicole helen samantha katherine christine rachel carolyn janet catherine maria heather
diane julie olivia joyce victoria kelly lauren christina joan megan andrea hannah jacqueline teresa ann sara madison
grace sophia natalie charlotte marie kate jane jenny harvey oscar ada otto hugo felix leo max
wei jing li min yan hui ying xin lei jun jie hao yu ming hong ping fang na tao jian bo yang lin qiang gang chao bin
long feng xiaoming xiaoyan lijuan yong hua
raj rahul amit anil sunil vijay ravi sanjay rajesh suresh ramesh mahesh ajay deepak arjun rohit vikram priya anjali
neha pooja sunita anita kavita ashok krishna arun manoj
ji seo young hyun soo jae sung minjun jiwoo
jose juan luis carlos jorge miguel pedro francisco antonio manuel jesus ana carmen rosa sofia diego alejandro fernando
javier ricardo
mohammed muhammad mohamed mohammad ahmed ahmad ali omar hassan hussein ibrahim mahmoud khalid abdullah yusuf youssef
mustafa fatima aisha`);

// Very common surnames across the same naming traditions.
const COMMON_SURNAME = words(`
smith johnson williams brown jones garcia miller davis rodriguez martinez hernandez lopez gonzalez wilson anderson
thomas taylor moore jackson martin lee perez thompson white harris sanchez clark ramirez lewis robinson walker young
allen king wright scott torres nguyen hill flores green adams nelson baker hall rivera campbell mitchell carter roberts
gomez diaz cruz morales reyes gutierrez ortiz ramos ruiz alvarez castillo jimenez moreno romero
wang li zhang liu chen yang huang zhao wu zhou xu sun ma zhu hu guo he lin gao luo zheng liang
patel kumar singh sharma gupta shah mehta reddy rao jain agarwal das
kim park choi jung jeong kang cho yoon jang lim
khan ahmed ali hassan hussein mohamed ibrahim rahman abdullah
tran le pham`);

// Nicknames: a weaker kind of match, never the full name.
const NICKNAME_GROUPS = [
  'william bill will billy liam', 'robert bob rob bobby robbie bert', 'richard rick dick rich ricky', 'james jim jimmy jamie',
  'john jack johnny', 'michael mike mick mikey', 'thomas tom tommy', 'joseph joe joey', 'charles charlie chuck',
  'christopher chris', 'daniel dan danny', 'matthew matt', 'anthony tony', 'edward ed eddie ted ned', 'elizabeth liz beth betsy lizzie eliza',
  'katherine kate katie kathy', 'catherine kate cathy', 'margaret maggie peggy meg', 'jennifer jen jenny', 'rebecca becky',
  'samuel sam sammy', 'benjamin ben benny', 'alexander alex xander', 'andrew andy drew', 'nicholas nick nicky', 'jonathan jon',
  'timothy tim timmy', 'stephen steve', 'steven steve', 'david dave davey', 'gregory greg', 'patrick pat paddy', 'peter pete',
  'susan sue suzy', 'deborah deb debbie', 'patricia pat patty trish', 'kenneth ken kenny', 'ronald ron ronnie', 'donald don donnie',
  'lawrence larry', 'gerald jerry', 'jeffrey jeff', 'frederick fred freddie', 'harold harry', 'henry harry hank',
  'theodore ted teddy theo', 'zachary zach zack', 'victoria vicky tori', 'jessica jess jessie', 'abigail abby', 'samantha sam',
  'alexandra alex sasha', 'joshua josh', 'nathaniel nate nat', 'nathan nate', 'raymond ray', 'leonard leo len lenny', 'vincent vince',
];
const NICKNAMES = new Map();
for (const g of NICKNAME_GROUPS) {
  const [formal, ...short] = g.split(' ');
  for (const s of short) {
    if (!NICKNAMES.has(formal)) NICKNAMES.set(formal, new Set());
    if (!NICKNAMES.has(s)) NICKNAMES.set(s, new Set());
    NICKNAMES.get(formal).add(s);
    NICKNAMES.get(s).add(formal);
  }
}

// Common English words that companies are named after. A company with such a
// name is only "named" where the text uses the word as a company.
const ORDINARY = words(`
ramp merge plaid notion square apple target stripe flow figure scale mercury block brex chime gusto rippling deel
loom slack zoom box dropbox snap pinterest uber lime bird wish poshmark compass opendoor robinhood coinbase ripple
circle gemini kraken anchor harbor harbour bridge arc arch atlas beacon bolt bloom blossom branch canvas carta cash
cedar chain charge check clear cloud coda codex comet core craft crest current dash delta drift echo edge ember
envoy epic equity fable fathom field fire flame fleet flex flight float focus forge form fort forward frame front
fuel fusion galaxy gather gem glass glow gold grain graph gravity grid grove guide guild harvest haven helix hero
hive hook horizon hub index ink insight iris jet journey key kin kind kite lab ladder lake lane lattice launch
layer leaf ledger lens level lift light line link lion loop lucid lumen luna lux maple map marble mark market mason
matter maven meadow mesh metric mint mirror mission mode monarch moon motion mountain nest nexus noble north nova
oak oasis ocean olive omni onyx orbit orchard origin otter pace palette parallel park path peak pebble pilot pine
pioneer pivot pixel plain plan planet play plum pocket point polar pond portal post prism pulse quest quill radar
radius rain range raven reach realm relay rise river road rocket root rose route sage sail salt scope scout sense
shift shield signal silver sky slate snow solid spark sphere spice spring sprout stack stage star steady stem
stone storm stream summit sun surge swift tandem tempo terra thread tide timber torch tower trail trellis tribe
true trust truth tulip union unity vault vector venture verse vertex vista vital voice wave willow wind wing wise
wolf wonder yard zen zero zone
able access action active acorn advance affirm agile aim air alert align alpha amber angel apex arrow ascent aspect
asset aura axis balance base basic beam bear bee bell best better big blade blend blue bold bond boost bright brick
brilliant broad buffer build button cable cadence calm camp candle canopy capital captain cargo carry castle cause
center central chalk champion chapter charm chart chef cherry chess chief circuit citizen civic clarity class clay
climb clock coast coin collective color column common company compound concord connect constant context copper
coral cornerstone counsel count country cove cover crane create credit crew crown crystal cube culture cup curve
cypress daily dawn day deep degree den design desk dial diamond digital direct discover dock domain door dot dove
draft dragon dream drive drop dune dynamic eagle earth east easy eco element elevate elite ember embark emerald
empire engine enterprise equal escape essential ethos even ever evolve exact expand express fair faith falcon fast
feather fern fiber fig finch first fix flag flare flash flora fluent fly fold forest fortune fox fresh friend
frontier fruit fund future garden gate general genesis giant gift glacier global globe goal good grace grand grant
green ground group grow guard gulf habit halo hammer happy hawk heart heat height hello help heritage hill hint home
honest honey hope house human hunt idea ideal ignite image impact infinite inspire instant integral iron island ivy
jade jam jewel joy jump junction jungle just keen kernel king knot lark laser latitude lead legacy legend liberty
life limit linear local lodge logic lotus loyal lumber lunar magic magnet main major mango mantra marathon marine
matrix maximum meridian merit meta method micro mind mobile modern module moment money monitor mosaic motive mule
native nature navy needle network new night nimble node noon notable novel number nutmeg object ocean octave offer
open opera optic oracle orange order organic outpost owl pacific page palm panda panther paper paragon passage patch
peach pearl pelican penny pepper perch petal phase phoenix piano piece pier pillar pin pioneer pipe pitch place
plaza plus poem polish pony portrait power practical prairie premier present prime prior private prize profit
project prompt proof prospect proto proud pure purple puzzle quad quality quantum quarter quartz quick quiet radiant
rally ranger rapid ratio ray ready real rebel record red reef reform remedy render rescue resolve rest retro reward
rhythm ridge right ring ripple rival rock rocket rogue roof round royal ruby rule runway rush safe saga sail sand
sapphire satellite savvy scale scholar school sea season second secure seed select sequence service settle shadow
shape share sharp shell shelter shore show sierra sight sign simple single site skill slice smart smile snap social
solar sonic sound source south space span spare speak spear spectrum speed spin spirit spot square stable standard
staple state station status steel step sterling stitch stock story strand strategy street strong studio style
sugar suite summer sunrise super supply sure sweet symbol sync system table tactic tag talent tally tango task
taste team tech tend thrive ticket tiger timeless token tone tool top total touch track trade transit treasure tree
trend trial triangle trio triumph tropic true tune turn twin ultra umbrella uplift upper urban valid valley value
vantage velvet venue verge verify vibe view village vine violet vision visit vivid volt voyage wall ward warm watch
water way wealth weave well west wheel whisper white wild window winter wire wonder wood word work world yellow
yield young zest zinc
`);

// Names that are places, numbers or joining words: what is left of a company name after generic words are removed
// ("Bank of America" -> "of america", "Capital One" -> "one", "Silicon Valley Bank" -> "silicon valley") must not
// stand for the company on its own.
const RESIDUE_STOP = words(`
one two three four five six seven eight nine ten hundred thousand first second third
of the and for in on at to by with a an
america american americas silicon valley new york london california texas florida europe european asia asian china
chinese india indian japan japanese africa african pacific atlantic national international global united first
general west east north south western eastern northern southern central city state states bay area paris berlin
boston chicago seattle miami dallas austin denver atlanta toronto canada uk us usa england british`);

const LEGAL_FORMS = words('inc incorporated llc llp lp ltd limited corp corporation co company plc gmbh ag sa sas sarl nv bv se pty ab oy spa srl kk lda');
const ROLE_WORDS = words('ceo ceos cto cfo coo cpo cmo cro founder founders cofounder cofounders co-founder co-founders chief president chairman chairwoman chair head director vp boss owner executive executives investor investors backers backer');
// Words that may follow a distinctive company name inside its own longer legal name ("Nikola Motor Company",
// "Theranos IP Company"). Never enough after an ordinary word ("Merge Labs" is not Merge).
const DESCRIPTORS = words('ai labs lab technologies technology tech group holdings motor motors ip systems software solutions financial health robotics energy therapeutics bio biosciences pharmaceuticals inc trading international global services markets exchange partners capital ventures management enterprises industries us usa uk europe digital networks media security data cloud');
const NAME_JOINERS = words('du de des la le les di da del della von van der den of &');
const FUNCTION_WORDS = words('with from by for at to and says said meet inside how why interview former ex avec pour chez vs versus on in as is was are about after before over into new');
const DETERMINERS = words('the a an this that these those its his her their our my your every no any some another each');
// After an ordinary word, these show it is being used as an ordinary word ("ramp up", "scale of the scheme").
const VERB_PARTICLES = words('up down out off over into onto together apart away back around through of');
// Directly after the company: it is the subject of a business sentence ("Merge raises", "Ramp said").
const BUSINESS_VERBS = words(`raises raised raising announces announced launches launched acquires acquired acquiring hires hired valued files
filed sues sued partners partnered expands expanded secures secured closes closed unveils unveiled introduces introduced
reaches reached says said confirms confirmed laid lays cuts cut plans planned debuts debuted rolls rolled appoints appointed
names named reports reported posts posted signs signed buys bought sells sold invests invested ipo goes went
processed processes grew grows employs serves ships shipped releases released offers offered opens opened crossed surpassed hits
settles settled faces agreed agrees pays paid`);
// A business word in the same clause shows the company is meant.
const BUSINESS_WORDS = words(`startup startups start-up fintech company companies firm valuation valued funding fundraise raised raises raise
round investors investor backers backed customers clients revenue ipo unicorn acquisition acquired merger cofounder co-founder
founder founders ceo cto cfo chief executive employees staff layoffs headquartered headquarters payments software platform saas
app product products series seed venture vc funded million billion shares stock shareholders board inc corp llc ltd`);

// Common words a sentence or a headline may put right after a company's name ("SoftBank Near Settlement").
const COMMON_CAPS = words(`near nears amid against after before under beyond above below despite during until since via per
trial case scandal stock stocks shares deal deals news report reports update updates story saga lawsuit lawsuits suit
settlement settles settle probe charges charged fraud verdict faces face gets get hits hit wins win loses lose plans plan
wants want could would will may might can should must has have had is was are were be been being does did do
not also still now then today yesterday this that these those its their his her where which who whom whose while when
team teams board office offices deal investor investors chief executives employees workers staff users customers
ipo valuation round funding unit units division arm subsidiary spokesperson spokesman spokeswoman`);

// Word edges by letters of any script, so a Latin word glued to Cyrillic or Han text is not cut out of it.
const COMPANY_GENERIC = /(?<![\p{L}\p{N}])(inc|llc|ltd|limited|corp|corporation|co|company|ai|labs|lab|technologies|technology|tech|group|holdings|plc|sa|sas|gmbh|the|io|com|financial|software|systems|solutions|networks|capital|partners|ventures|health|robotics|energy|security|data|cloud|digital|media|bank)(?![\p{L}\p{N}])/gu;
const LEGAL_RE = /(?<![\p{L}\p{N}])(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|plc|sa|sas|sarl|gmbh|ag|bv|nv|pty|lp|llp|the)(?![\p{L}\p{N}])/gu;
// Legal forms used outside the US, written as they are once dots and commas are spaces ("S.A. de C.V." ->
// "s a de c v"). They are removed only at the end of a name, after at least one other word, because several are
// also ordinary words or letters ("As Seen On Screen", "Studio A"). A typed registered name ("Zepto Technologies
// Private Limited") then keeps its brand ("zepto") as the key the press uses.
const LEGAL_TAIL_FORMS = [
  'private limited', 'pvt ltd', 'pvt', 'pte ltd', 'pte', 'ltda', 'eireli', 'sdn bhd', 'bhd', 'tbk',
  'pjsc', 'ojsc', 'cjsc', 'jsc', 'ooo', 'oao', 'zao', 'pao', 'ao',
  'ab publ', 'publ', 'ab', 'asa', 'as', 'a s', 'aps', 'a p s', 'oyj', 'oy', 'kft', 'zrt', 'nyrt', 'bt',
  'sp z o o', 'sp zoo', 'spolka z o o', 'sp j', 'sp k', 's a de c v', 'sa de cv', 's de r l de c v', 's de rl de cv',
  's a p i de c v', 'sapi de cv', 'de c v', 'de cv', 's a s', 's a r l', 's a', 's r l', 'srl', 's p a', 'spa', 's l u', 'slu', 's l', 'sl',
  's r o', 'sro', 'a s', 'd o o', 'doo', 'd d', 'k k', 'kk', 'g k', 'gk', 'kabushiki kaisha', 'godo kaisha', 'yugen kaisha',
  'co ltd', 'ltd', 'limited', 'gmbh', 'gmbh co kg', 'gmbh co', 'kg', 'kgaa', 'ag', 'ug', 'e v', 'ev', 'bv', 'b v', 'nv', 'n v',
  'se', 'sarl', 'sas', 'sasu', 'sa', 'plc', 'llc', 'inc', 'corp', 'pty ltd', 'pty', 'oü', 'ou', 'uab', 'sia', 'ehf', 'hf',
];
const LEGAL_TAIL_RE = new RegExp(`(?<=\\S)\\s+(?:${[...LEGAL_TAIL_FORMS].sort((a, b) => b.length - a.length).map((f) => f.split(' ').join('\\s+')).join('|')})$`, 'u');
// "PT Gojek Indonesia", "CV Maju": an Indonesian legal form written before the name.
const LEGAL_HEAD_RE = /^(?:pt|cv)\s+(?=\S+)/u;
/** Remove legal forms written at the end (and the Indonesian ones at the start) of a name, as often as they repeat. */
function stripLegalEnds(norm) {
  let s = norm.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4; i += 1) {
    const next = s.replace(LEGAL_TAIL_RE, '').replace(LEGAL_HEAD_RE, '').trim();
    if (next === s || !next) break;
    s = next;
  }
  return s;
}
// Letters of scripts written without spaces between words (Han, kana, Thai, Hangul run together with particles):
// a name in one of them is found inside a longer run of letters.
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Hangul}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const caseless = (w) => /\p{L}/u.test(w) && w.toLowerCase() === w.toUpperCase();

// ---------------------------------------------------------------------------
// Person names.
// ---------------------------------------------------------------------------

const bare = (t) => lowerFold(t).replace(/[.,]/g, '');

/**
 * Split a typed name into its parts.
 * "Dr. Eric M. Glyman Jr." -> { given: 'Eric', middles: ['M.'], surname: 'Glyman', suffix: 'jr', title: 'dr' }
 * "Glyman, Eric" is read as Eric Glyman. Lowercase particles stay with the surname ("Ludwig van Beethoven").
 */
export function parsePersonName(raw) {
  let s = String(raw || '').replace(/["“”„]/g, '').replace(/[’']s\b/g, '').replace(/\s+/g, ' ').trim();
  let suffix = '';
  let title = '';
  // "Smith, John" (and "Smith, John Jr.") -> "John Smith"; "John Smith, Jr." keeps its order.
  const comma = s.match(/^([^,]+),\s*([^,]+?)(?:,\s*([^,]+))?$/);
  if (comma) {
    const second = comma[2].trim();
    const secondBare = second.split(/\s+/).map(bare);
    if (secondBare.every((t) => GENERATIONAL.has(t) || DEGREE_SUFFIX.has(t))) {
      suffix = secondBare.find((t) => GENERATIONAL.has(t)) || '';
      s = comma[1].trim();
    } else {
      s = `${second} ${comma[1].trim()}${comma[3] ? ` ${comma[3].trim()}` : ''}`;
    }
  }
  let tokens = s.split(' ').filter(Boolean);
  while (tokens.length > 2 && TITLES.has(bare(tokens[0]))) { title = title || bare(tokens[0]); tokens = tokens.slice(1); }
  while (tokens.length > 2 && (GENERATIONAL.has(bare(tokens[tokens.length - 1])) || DEGREE_SUFFIX.has(bare(tokens[tokens.length - 1])))) {
    const t = bare(tokens[tokens.length - 1]);
    if (GENERATIONAL.has(t) && !suffix) suffix = t;
    tokens = tokens.slice(0, -1);
  }
  if (!tokens.length) return { display: '', given: '', middles: [], surname: '', suffix, title, tokens: [] };
  if (tokens.length === 1) return { display: tokens[0], given: tokens[0], middles: [], surname: '', suffix, title, tokens };
  let cut = tokens.length - 1;
  while (cut > 1 && SURNAME_PARTICLES.has(tokens[cut - 1].toLowerCase()) && tokens[cut - 1] === tokens[cut - 1].toLowerCase()) cut -= 1;
  return {
    display: tokens.join(' '),
    given: tokens[0],
    middles: tokens.slice(1, cut),
    surname: tokens.slice(cut).join(' '),
    suffix,
    title,
    tokens,
  };
}

/** The name without titles and generational or degree suffixes, in Given Surname order. */
export const cleanPersonName = (raw) => parsePersonName(raw).display;

/**
 * How common a name is. A very common full name ("John Smith", "Wei Zhang")
 * is shared by thousands of people, so a record needs the company or another
 * anchor to be tied to the person.
 * @returns {{ common: boolean, givenCommon: boolean, surnameCommon: boolean }}
 */
export function nameCommonness(name) {
  const p = parsePersonName(name);
  const given = lowerFold(p.given).split(/[-\s]+/)[0] || '';
  const surname = lowerFold(p.surname).split(/\s+/).pop() || '';
  const givenCommon = COMMON_GIVEN.has(given) || COMMON_GIVEN.has(lowerFold(p.given).replace(/[-\s]+/g, ''));
  const surnameCommon = COMMON_SURNAME.has(surname);
  return { common: Boolean(surname) && givenCommon && surnameCommon, givenCommon, surnameCommon };
}

/** True for a very common full name ("John Smith", "Wei Zhang", "Jack Zhang"). */
export const isCommonName = (name) => nameCommonness(name).common;

const B = "(?<![\\p{L}\\p{N}])(?<!\\p{L}[-'])";
// Up to two middle names or initials; the first may be joined by a hyphen ("Jean-Pierre" for typed "Jean Pierre").
const MIDDLE = "((?:(?:\\s+|-)(?:\\p{L}\\.|\\p{L}[\\p{L}'-]*\\.?)){0,2}?)";
const partRe = (word) => escapeRe(lowerFold(word).replace(/\.$/, '')).replace(/'/g, "'?");
const givenRe = (given) => lowerFold(given).split(/[-\s]+/).filter(Boolean).map(partRe).join('(?:-|\\s+)');
const surnameRe = (surname) => surname.split(/\s+/).map(partRe).join('\\s+');
const NOT_A_MIDDLE = words('and of the or to in for with by is was says said vs on at as ceo cto cfo founder chief former');

/**
 * A matcher for one person's name.
 * Returns test(text) -> boolean (the full name is written), with
 *   .positions(text)      -> [{ start, end, text, kind: 'full'|'reversed-comma' }]
 *   .weakPositions(text)  -> [{ start, end, text, kind }] for the weaker kinds
 *                            ('reversed', 'initials', 'nickname', 'longer-surname', 'other-middle', 'other-suffix', 'other-given')
 *   .kind(text)           -> 'full' | one of the weak kinds | 'none'
 *   .parts                -> the parsed name
 */
export function personNameMatcher(name) {
  const p = parsePersonName(name);
  const none = () => false;
  none.positions = () => [];
  none.weakPositions = () => [];
  none.kind = () => 'none';
  none.parts = p;
  if (!p.given) return none;
  const single = !p.surname;
  // A name in a script written without spaces ("张一鸣", "이재용") is a full name in one run of letters, and sits
  // inside a run of letters in a sentence; only a Latin letter or digit beside it marks another word.
  const unspaced = single && UNSPACED_SCRIPT.test(p.given);
  // One word in a spaced script ("Budi"): a person known by one name. Callers grade it more strictly.
  const mononym = single && !unspaced;
  const G = givenRe(p.given);
  const S = single ? '' : surnameRe(p.surname);
  const forward = unspaced ? new RegExp(`(?<![A-Za-z0-9])${G}(?![A-Za-z0-9])`, 'giu')
    : single ? new RegExp(`${B}${G}(?![\\p{L}\\p{N}])`, 'giu') : new RegExp(`${B}${G}${MIDDLE}\\s+${S}(?![\\p{L}\\p{N}])`, 'giu');
  const reversedComma = single ? null : new RegExp(`${B}${S}\\s*,\\s*${G}${MIDDLE}(?![\\p{L}\\p{N}])`, 'giu');
  const reversedBare = single ? null : new RegExp(`${B}${S}\\s+${G}(?![\\p{L}\\p{N}])`, 'giu');
  const initials = single ? null : new RegExp(`${B}((?:\\p{L}\\.\\s*){1,3})${S}(?![\\p{L}\\p{N}])`, 'giu');
  const nicks = [...(NICKNAMES.get(lowerFold(p.given)) || [])];
  const nickRe = single || !nicks.length ? null : new RegExp(`${B}(?:${nicks.map(partRe).join('|')})${MIDDLE}\\s+${S}(?![\\p{L}\\p{N}])`, 'giu');
  const otherGiven = single ? null : new RegExp(`${B}(\\p{L}[\\p{L}]+)\\s+${S}(?![\\p{L}\\p{N}])`, 'giu');
  const subjectMiddles = p.middles.map((m) => lowerFold(m).replace(/\.$/, '')).filter(Boolean);
  const subjectSuffix = p.suffix;

  // A word in a script without capitals (Han, Arabic, Hebrew...) is written as a name however it is written.
  const capitalised = (w) => /^\p{Lu}/u.test(w) || caseless(w);
  const wordsOf = (s) => s.split(/[\s,]+/).flatMap((w) => w.split('-')).filter((w) => w && w !== '.');
  const middleState = (mid) => {
    const ms = wordsOf(mid).map((w) => w.replace(/\.$/, ''));
    // A hyphen after the given name joins a double given name: only the subject's own ("Jean-Pierre"), never
    // another one ("Anne-Marie" for Anne).
    if (/^-/.test(mid) && !(subjectMiddles[0] && ms[0] && subjectMiddles[0] === ms[0].toLowerCase())) return 'reject';
    for (const m of ms) {
      if (!capitalised(m) || NOT_A_MIDDLE.has(m.toLowerCase())) return 'reject';
    }
    if (!subjectMiddles.length || !ms.length) return 'ok';
    const fits = ms.every((m) => {
      const l = m.toLowerCase();
      return subjectMiddles.some((sm) => sm === l || (l.length === 1 && sm[0] === l) || (sm.length === 1 && l[0] === sm));
    });
    return fits ? 'ok' : 'other-middle';
  };

  const scan = (str) => {
    const { text, map } = foldWithMap(str);
    const toOrig = (s, e) => ({ start: map[s], end: map[e] ?? str.length });
    const full = [];
    const weak = [];
    const push = (list, s, e, kind) => {
      const o = toOrig(s, e);
      list.push({ ...o, text: str.slice(o.start, o.end), kind });
    };
    for (const m of text.matchAll(forward)) {
      const s = m.index;
      const e = s + m[0].length;
      const mid = single ? '' : (m[1] || '');
      // Every part of the name is written as a name: "Grace Hopper", "GRACE HOPPER", never "grace hopper".
      const nameWords = wordsOf(m[0]).filter((w) => !wordsOf(mid).includes(w));
      if (!nameWords.every(capitalised)) continue;
      const after = text.slice(e);
      if (/^'(?!s(?![\p{L}]))\p{L}/u.test(after)) continue; // "Smith'son": inside another word
      if (/^-\p{L}/u.test(after)) { push(weak, s, e, 'longer-surname'); continue; } // "John Smith-Jones"
      // "Erin Elizabeth Holmes" for Elizabeth Holmes: a given name written right before the name makes it someone
      // else's longer name. A known given name counts anywhere; another capitalised word only inside a sentence
      // written in lower case ("the trust for Erin Elizabeth Holmes"), so a title-case headline ("Convicted
      // Fraudster Elizabeth Holmes"), a list ("Balwani and Elizabeth Holmes") or a title ("Senator") does not.
      if (!single) {
        const before = text.slice(0, s);
        const prevW = before.match(/(?<![\p{L}'’.-])(\p{Lu}\p{Ll}+)\s+$/u);
        const g = prevW ? lowerFold(prevW[1]) : '';
        const own = g === lowerFold(p.given) || subjectMiddles.includes(g) || (NICKNAMES.get(lowerFold(p.given)) || new Set()).has(g);
        let otherGivenName = false;
        if (g && !own && !NOT_A_GIVEN.has(g) && !TITLES.has(g) && !ROLE_WORDS.has(g) && !FUNCTION_WORDS.has(g) && !DETERMINERS.has(g) && !LEGAL_FORMS.has(g) && !BUSINESS_VERBS.has(g)) {
          const at = s - prevW[0].length;
          const lowerBefore = /(?:^|[\s(])\p{Ll}[\p{L}'’-]*[,;:]?\s+$/u.test(before.slice(0, at));
          otherGivenName = COMMON_GIVEN.has(g) || (lowerBefore && !atSentenceStart(text, at));
        }
        if (otherGivenName) {
          push(weak, s - prevW[0].length, e, 'other-given');
          continue;
        }
      }
      if (mononym) {
        // A one-word name followed or preceded by another capitalised name word is part of someone's longer
        // name ("Budi Santoso", "Rina Budi"), not the person known only as Budi.
        const nextW = after.match(/^\s+(\p{Lu}[\p{L}'-]*)/u);
        const prevW = text.slice(0, s).match(/(\p{Lu}[\p{L}'-]*)\s+$/u);
        const nameLike = (w) => w && !ROLE_WORDS.has(lowerFold(w)) && !FUNCTION_WORDS.has(lowerFold(w)) && !TITLES.has(lowerFold(w).replace(/\.$/, ''))
          && !DETERMINERS.has(lowerFold(w)) && !LEGAL_FORMS.has(lowerFold(w)) && !BUSINESS_VERBS.has(lowerFold(w));
        const prevAtStart = prevW && atSentenceStart(text, prevW.index);
        if ((nextW && nameLike(nextW[1])) || (prevW && nameLike(prevW[1]) && !prevAtStart)) { push(weak, s, e, 'longer-name'); continue; }
      }
      const ms = single ? 'ok' : middleState(mid);
      if (ms === 'reject') {
        // the gap is not a middle name ("John And Smith"): try again without it is not possible here
        continue;
      }
      if (ms === 'other-middle') { push(weak, s, e, 'other-middle'); continue; }
      const suf = after.match(/^\s*,?\s*(jr|sr|ii|iii|iv)\b\.?/i);
      if (subjectSuffix && suf && suf[1].toLowerCase() !== subjectSuffix) { push(weak, s, e, 'other-suffix'); continue; }
      push(full, s, e, 'full');
    }
    if (reversedComma) {
      for (const m of text.matchAll(reversedComma)) {
        const s = m.index;
        const e = s + m[0].length;
        if (full.some((f) => f.start <= map[s] && map[s] < f.end)) continue;
        const mid = m[1] || '';
        if (!wordsOf(m[0]).every(capitalised)) continue;
        // "Smith, John and Jane Doe were sued" reads as a list; only a register-style line ends after the name
        const after = text.slice(e);
        if (/^\s+(?:and|&)\s+\p{Lu}/u.test(after)) continue;
        const ms = middleState(mid);
        if (ms === 'reject') continue;
        push(ms === 'ok' ? full : weak, s, e, ms === 'ok' ? 'reversed-comma' : 'other-middle');
      }
    }
    full.sort((a, b) => a.start - b.start);
    return { text, map, full, weak, toOrig, push };
  };

  const positions = (str) => scan(String(str || '')).full;
  const weakPositions = (str) => {
    const s0 = String(str || '');
    const { text, full, weak, push } = scan(s0);
    if (single) return weak;
    const overlaps = (a) => full.some((f) => a.start < f.end && f.start < a.end) || weak.some((w) => a.start < w.end && w.start < a.end);
    const add = (list, re, kind, ok = () => true) => {
      if (!re) return;
      for (const m of text.matchAll(re)) {
        if (!ok(m)) continue;
        const tmp = [];
        push(tmp, m.index, m.index + m[0].length, kind);
        if (!overlaps(tmp[0])) list.push(tmp[0]);
      }
    };
    const capitalisedAll = (m) => wordsOf(m[0]).every((w) => /^\p{Lu}/u.test(w));
    add(weak, reversedBare, 'reversed', capitalisedAll);
    add(weak, initials, 'initials', capitalisedAll);
    add(weak, nickRe, 'nickname', capitalisedAll);
    const givenKey = lowerFold(p.given);
    add(weak, otherGiven, 'other-given', (m) => {
      if (!capitalisedAll(m)) return false;
      const g = lowerFold(m[1]);
      return g !== givenKey && !TITLES.has(g) && !ROLE_WORDS.has(g) && !FUNCTION_WORDS.has(g) && !DETERMINERS.has(g) && !(NICKNAMES.get(givenKey) || new Set()).has(g);
    });
    return weak.sort((a, b) => a.start - b.start);
  };
  const test = (str) => positions(str).length > 0;
  test.positions = positions;
  test.weakPositions = weakPositions;
  test.kind = (str) => {
    if (test(str)) return 'full';
    const w = weakPositions(str);
    return w.length ? w[0].kind : 'none';
  };
  test.parts = p;
  test.mononym = mononym;
  return test;
}

/**
 * The search forms of a name: as typed (without titles or suffixes), and given
 * name plus surname without any middle names ("Elizabeth Anne Holmes" ->
 * ["Elizabeth Anne Holmes", "Elizabeth Holmes"]).
 */
export function personNameVariants(name) {
  const p = parsePersonName(name);
  if (!p.display) return [];
  const out = [p.display];
  if (p.middles.length && p.surname) out.push(`${p.given} ${p.surname}`);
  return out;
}

// ---------------------------------------------------------------------------
// Company names.
// ---------------------------------------------------------------------------

/** "Mistral AI, Inc." -> ["mistral"]: legal forms and describing words removed (a key for grouping, not for matching). */
export function companyKeys(company) {
  // Letters of every script are kept ("Яндекс", "字节跳动"): a key of nothing could never match.
  const norm = (s) => stripLegalEnds(lowerFold(s).replace(/[^\p{L}\p{N} ]+/gu, ' '))
    .replace(COMPANY_GENERIC, ' ')
    .replace(/\s+/g, ' ').trim();
  const full = norm(company);
  return full ? [full] : [];
}

/** "Mistral AI, Inc." -> "mistral ai": only the legal form removed. */
export function companyKeyStrict(name) {
  return stripLegalEnds(lowerFold(name).replace(/[^\p{L}\p{N} ]+/gu, ' '))
    .replace(LEGAL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when a company is named with one ordinary word (Ramp, Merge, Plaid, Notion, Square, Apple, Target, Harvey). */
export function isOrdinaryWordCompany(company) {
  const strict = companyKeyStrict(company);
  const loose = companyKeys(company)[0] || '';
  const one = !/\s/.test(strict) ? strict : (!/\s/.test(loose) ? loose : '');
  if (!one) return false;
  return ORDINARY.has(one) || COMMON_GIVEN.has(one) || COMMON_SURNAME.has(one) || RESIDUE_STOP.has(one);
}

/**
 * The forms of a company name that may be looked for in text, and whether each
 * one is an ordinary word. The registered name without its legal form always;
 * the shorter key (describing words removed: "Scale AI" -> "scale") only when it
 * is one word that is not a place, a number or a joining word, so "Silicon
 * Valley Bank", "Bank of America" and "Capital One" are only ever matched whole.
 * @returns {{ form: string, ordinary: boolean, multi: boolean }[]}
 */
export function companyMatchForms(company) {
  const strict = companyKeyStrict(company);
  const out = [];
  if (strict.length >= 2) out.push({ form: strict, ordinary: !/\s/.test(strict) && isOrdinaryWordCompany(strict), multi: /\s/.test(strict) });
  const loose = companyKeys(company)[0] || '';
  if (loose && loose !== strict && loose.length >= 3 && !/\s/.test(loose) && !RESIDUE_STOP.has(loose) && !/^\d+$/.test(loose)) {
    out.push({ form: loose, ordinary: isOrdinaryWordCompany(loose), multi: false });
  }
  return out;
}

const wordKey = (w) => lowerFold(w).replace(/^[^a-z0-9&]+|[^a-z0-9&]+$/g, '');
const startsCapital = (w) => /^[^\p{L}\p{N}]*\p{Lu}/u.test(w);
const hasCapital = (w) => /\p{Lu}/u.test(w);

/** The word right before a span, only when nothing but spaces separates them. */
function wordBefore(str, at) {
  const m = str.slice(0, at).match(/(\S+)[ \t]+$/);
  if (!m || /[,;:)\]}.!?"”—–|]$/.test(m[1])) return null;
  return { word: m[1], at: m.index };
}
const atSentenceStart = (str, at) => /(^|[.!?]["”’)]*\s+|\n\s*|[:|—–]\s+|["“'‘(]\s*)$/.test(str.slice(0, at));
/** Title Case or capitals around the span: almost no long word is lowercase. */
function inHeadline(str, start, end) {
  const near = `${str.slice(Math.max(0, start - 80), start)} ${str.slice(end, end + 80)}`.replace(/\[[^\]]{1,12}\]/g, ' ');
  const long = near.match(/[A-Za-zÀ-ɏ]{5,}/g) || [];
  return long.length >= 3 && long.filter((w) => w === w.toLowerCase()).length / long.length < 0.2;
}
/** The clause around a span: bounded by sentence ends, colons, semicolons, dashes and bars. */
function clauseAround(str, start, end, reach = 70) {
  const left = str.slice(Math.max(0, start - reach), start);
  const right = str.slice(end, end + reach);
  const l = left.split(/[.!?;:|—–\n](?=\s)|[;:|—–\n]/).pop();
  const r = right.split(/[.!?](?=\s|$)|[;:|—–\n]/)[0];
  return { left: l, right: r };
}

const ROLE_BEFORE = /\b(?:co-?founders?|founders?|officers?|ceo|cto|cfo|coo|cpo|chief\s+\w+(?:\s+officer)?|president|chair(?:man|woman|person)?|director|head\s+of\s+\w+|vp(?:\s+of\s+\w+)?|vice\s+president(?:\s+of\s+\w+)?|engineer|employee|partner|investor|board\s+member|executive|manager|staff|team|alum(?:nus|na|ni)?)\s+(?:(?:and|&)\s+[\w-]+\s+)?(?:of|at)\s+$/i;
const ROLE_TEXT = /\b(?:co-?founder|founder|ceo|cto|cfo|coo|chief|president|director|head|vp|engineer|manager|partner|investor|officer|lead)\b/i;
// "Larry Dean Harmon d/b/a Helix", "trading as Flow": a business name follows.
const TRADE_NAME_BEFORE = /(?:\bd\/b\/a|\bdba|\bdoing\s+business\s+as|\btrading\s+as|\bt\/a|\bf\/k\/a|\bformerly\s+known\s+as)\s+$/i;
const VERB_BEFORE = /\b(?:at|joined|joins|founded|co-?founded|cofounded|left|leaves|leads|led|runs|ran|heads|backed|backs|invested\s+in|invests\s+in|acquired\s+by|acquires|acquired|buys|bought|sold|works\s+at|worked\s+at|sues|sued)\s+$/i;

/**
 * Does `text` name `company`, and how strongly?
 * @param {string} company  the company as typed or registered
 * @param {string} text
 * @param {{ aliases?: string[], person?: Function, personWords?: string[] }} opts
 *   aliases: fuller legal names or domains learned for this company ("Ramp Business Corp", "ramp.com");
 *   person: a name matcher (personNameMatcher) whose mention beside the company is itself a company marker
 *   ("John Smith of Ramp", "John Smith (Ramp)");
 *   personWords: words of the person's own name, never read as part of a longer organisation name.
 * @returns {{ named: boolean, strength: 'strong'|'marker'|'plain'|'none', spans: {start,end,strength,how}[] }}
 *   strong: a legal form, a domain or handle, or a learned legal name; marker: an ordinary word used as a company;
 *   plain: a distinctive name written as a name.
 */
export function companyMention(company, text, opts = {}) {
  return companyMentionMatcher(company, opts)(text);
}

const STRENGTH_RANK = { none: 0, plain: 1, marker: 2, strong: 3 };

/**
 * A reusable form of companyMention: companyMentionMatcher(company, opts)(text) -> the same result.
 * `opts.aliases` may be a function returning the current list, so aliases learned later are seen.
 */
export function companyMentionMatcher(company, opts = {}) {
  const raw = String(company || '').trim();
  const empty = { named: false, strength: 'none', spans: [] };
  if (raw.length < 2) return () => empty;
  const forms = companyMatchForms(raw);
  const ownWords = new Set(raw.split(/\s+/).map(wordKey).filter(Boolean));
  const personWords = new Set((opts.personWords || []).map((w) => lowerFold(w)));
  const formRes = forms.map((f) => {
    const body = f.form.split(' ').map(escapeRe).join('[\\s-]+');
    // A name in a script written without spaces ("字节跳动的创始人") sits inside a run of letters: only a Latin
    // letter or digit beside it marks another word.
    const unspaced = UNSPACED_SCRIPT.test(f.form);
    return {
      ...f,
      unspaced,
      re: unspaced
        ? new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'giu')
        : new RegExp(`(?<![\\p{L}\\p{N}])(?<!\\p{L}-)${body}(?![\\p{L}\\p{N}])(?!-\\p{L})`, 'giu'),
    };
  });
  // Handles and domains often glue a word to the name ("@acmemotor", "acmemotor.com"). The key counts as the
  // start of an @handle or a domain label when it has 5 or more characters and is not the person's own name.
  const prefixes = [...new Set(forms.map((f) => f.form.replace(/\s+/g, '')))]
    .filter((k) => k.length >= 5 && /^[a-z0-9]+$/.test(k) && !personWords.has(k))
    .flatMap((k) => [
      new RegExp(`(?<![A-Za-z0-9_])@${escapeRe(k)}[a-z0-9_]*(?![A-Za-z0-9_])`, 'gi'),
      new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(k)}[a-z0-9-]*\\.[a-z]{2,6}(?![A-Za-z0-9])`, 'gi'),
    ]);
  const aliasList = () => (typeof opts.aliases === 'function' ? opts.aliases() : (opts.aliases || []));
  const person = opts.person || null;

  const neutral = (w) => {
    const k = wordKey(w);
    if (LEGAL_FORMS.has(k) || ROLE_WORDS.has(k) || FUNCTION_WORDS.has(k) || ownWords.has(k) || personWords.has(k)) return true;
    // The person's own (hyphenated) name beside the company: "Sam Bankman-Fried of FTX"
    const parts = k.split('-').filter(Boolean);
    return parts.length > 1 && parts.every((x) => personWords.has(x));
  };

  // Whether the occurrence [start,end) is one part of a longer, different name ("Cash Flow Capital", "Boat Ramp",
  // "Domaine du Mistral", "Harvey Weinstein", "Merge Labs").
  const insideLongerName = (str, start, end, form) => {
    const after = str.slice(end);
    const next = after.match(/^[ \t]+(\S+)/);
    const nextKey = next ? wordKey(next[1]) : '';
    const titled = /^['’]s\b/i.test(after) || Boolean(next && ROLE_WORDS.has(nextKey));
    const headline = inHeadline(str, start, end);
    const prev = wordBefore(str, start);
    if (prev && !/['’]s$/i.test(prev.word)) {
      if (NAME_JOINERS.has(wordKey(prev.word)) || prev.word === '&') {
        const head = wordBefore(str, prev.at);
        if (head && startsCapital(head.word) && !neutral(head.word)) {
          // In prose a joined name stays one name ("Domaine du Mistral CEO"). In a headline a capitalised joiner
          // ("Worth Of Acme Stock") is only Title Case, and a possessive or title marks the company.
          if (!headline) return true;
          if (!(startsCapital(prev.word) || titled)) return true;
        }
      } else if (startsCapital(prev.word) && !neutral(prev.word) && !titled && !atSentenceStart(str, prev.at) && !headline) {
        return true;
      }
    }
    // A capitalised word after a one-word name continues another name ("Harvey Weinstein", "Merge Labs",
    // "Mercury Records"), unless it is a legal form, a role, a business verb or, after a distinctive name, a
    // describing word of its own legal name ("Nikola Motor Company"). Title Case headlines say nothing.
    if (!form.multi && next && startsCapital(next[1]) && !headline) {
      // After a distinctive name, a common word is not part of a longer name ("SoftBank Near Settlement",
      // "Theranos Trial"); a proper name is ("Nikola Tesla Institute").
      const commonNext = !form.ordinary && (DESCRIPTORS.has(nextKey) || ORDINARY.has(nextKey) || COMMON_CAPS.has(nextKey) || BUSINESS_WORDS.has(nextKey));
      if (!(LEGAL_FORMS.has(nextKey) || ROLE_WORDS.has(nextKey) || BUSINESS_VERBS.has(nextKey) || FUNCTION_WORDS.has(nextKey)
        || personWords.has(nextKey) || commonNext)) {
        return true;
      }
    }
    return false;
  };

  // An ordinary word is the company only with a sign of business use beside it.
  const markerFor = (str, start, end) => {
    const after = str.slice(end);
    const before = str.slice(Math.max(0, start - 60), start);
    const next = after.match(/^(?:['’]s)?[ \t]+([^\s,.;:!?)]+)/);
    const nextKey = next ? wordKey(next[1]) : '';
    if (/^['’]s\b/i.test(after)) {
      // "Ramp's backers", "Ramp's co-founder", "Ramp's John Smith"
      const two = after.slice(2, 40).match(/^\s+(\S+)(?:\s+(\S+))?/);
      const ws = two ? [two[1], two[2]].filter(Boolean).map(wordKey) : [];
      if (ws.some((w) => ROLE_WORDS.has(w) || BUSINESS_WORDS.has(w))) return 'possessive';
      if (person && person(after.slice(2, 60))) return 'possessive-person';
    }
    if (next && (ROLE_WORDS.has(nextKey) || BUSINESS_VERBS.has(nextKey))) return 'role-or-verb-after';
    if (ROLE_BEFORE.test(before)) return 'role-before';
    if (TRADE_NAME_BEFORE.test(before)) return 'trade-name';
    // The whole sentence or field is the company ("... Affiliations: Stripe. Papers ...", a bio reading "Stripe.").
    if (/(?:^|[.!?:]\s+|\s[|;]\s|;\s*)$/.test(str.slice(0, start)) && /^(?:[.!?](?:\s|$)|\s*$|\s[|;]\s|\s*;)/.test(str.slice(end))) return 'standalone';
    // A field of a structured record about the person ("Patrick Collison; Stripe; ..."): a register's company field.
    if (person && isWholeField(str, start, end) && person.positions(str).some((p) => isWholeField(str, p.start, p.end))) return 'record-field';
    if (VERB_BEFORE.test(before)) return 'verb-before';
    if (person) {
      // "John Smith of Ramp", "John Smith, Ramp", "John Smith (Ramp)", "John Smith at Ramp"
      const tail = before.match(/(?:\s+(?:of|at|from)\s+|\s*,\s*|\s*\(\s*|\s+[-–—|·]\s+)$/);
      if (tail) {
        const lead = before.slice(0, before.length - tail[0].length);
        const ps = person.positions(lead);
        if (ps.length && ps[ps.length - 1].end === lead.length) return 'beside-person';
      }
      // A profile title from search results: "Jane Roe – Co-Founder & CEO – Ramp | LinkedIn"
      const wide = str.slice(Math.max(0, start - 140), start);
      const parts = wide.split(/\s+[-–—|·]\s+/);
      if (parts.length >= 3 && parts[parts.length - 1] === '' && ROLE_TEXT.test(parts[parts.length - 2])) {
        const lead = parts[parts.length - 3];
        const ps = person.positions(lead);
        if (ps.length && ps[ps.length - 1].end === lead.length) return 'profile-title';
      }
    }
    const { left, right } = clauseAround(str, start, end);
    const clauseWords = `${left} ${right}`.split(/[^\p{L}\p{N}$-]+/u).map((w) => w.toLowerCase()).filter(Boolean);
    if (clauseWords.some((w) => BUSINESS_WORDS.has(w))) return 'business-word';
    if (/\$\s?\d/.test(`${left} ${right}`) || /\bseries\s+[a-f]\b/i.test(`${left} ${right}`)) return 'business-word';
    return null;
  };

  return (input) => {
    const str = String(input || '');
    if (!str) return empty;
    const { text, map } = foldWithMap(str);
    const orig = (s, e) => ({ start: map[s], end: map[e] ?? str.length });
    const spans = [];
    const add = (s, e, strength, how) => spans.push({ ...orig(s, e), strength, how });

    for (const re of prefixes) {
      for (const m of text.matchAll(re)) {
        if (m[0].startsWith('@') || /\.[a-z]{2,6}$/.test(m[0])) add(m.index, m.index + m[0].length, 'strong', m[0].startsWith('@') ? 'handle' : 'domain');
      }
    }
    // Learned legal names and domains of this company ("Ramp Business Corp" -> "Ramp Business UK Ltd" ties).
    for (const alias of aliasList()) {
      const a = String(alias || '').trim();
      if (!a) continue;
      if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(a)) {
        const re = new RegExp(`(?<![A-Za-z0-9-])${escapeRe(a)}(?![A-Za-z0-9-])`, 'gi');
        for (const m of text.matchAll(re)) add(m.index, m.index + m[0].length, 'strong', 'domain');
        continue;
      }
      const core = companyKeyStrict(a);
      if (!core) continue;
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${core.split(' ').map(escapeRe).join('[\\s-]+')}(?![\\p{L}\\p{N}])`, 'giu');
      for (const m of text.matchAll(re)) {
        const s = m.index;
        const e = s + m[0].length;
        if (!hasCapital(m[0])) continue;
        const prev = wordBefore(text, s);
        if (prev && startsCapital(prev.word) && !neutral(prev.word) && !atSentenceStart(text, prev.at) && !inHeadline(text, s, e)) continue;
        add(s, e, 'strong', 'legal-name');
      }
    }
    for (const f of formRes) {
      for (const m of text.matchAll(f.re)) {
        const s = m.index;
        const e = s + m[0].length;
        const before = s > 0 ? text[s - 1] : '';
        // An address or handle: "stripe.com", "/company/stripe", "@stripe"
        if (before && '/@.'.includes(before)) { add(s, e, 'strong', 'address'); continue; }
        if (/^\.[a-z]{2,6}(?![a-z])/.test(text.slice(e, e + 8))) { add(s, e, 'strong', 'domain'); continue; }
        // A name in a script without capitals (Han, kana, Thai...) is a name as written.
        if (f.unspaced || caseless(m[0])) { add(s, e, f.ordinary ? 'marker' : 'plain', 'name'); continue; }
        // A name is written with a capital somewhere ("Stripe", "dHybrid", "STRIPE"); "a blue stripe" is a word.
        if (!hasCapital(m[0])) continue;
        if (f.multi) {
          // Every main word of a longer name is capitalised ("Bank of America", not "bank of America")
          if (m[0].split(/[\s-]+/).some((w) => w.length >= 3 && !NAME_JOINERS.has(w.toLowerCase()) && !startsCapital(w))) continue;
        }
        const tail = text.slice(e);
        // A legal form right after the name. The short ones are also ordinary words ("Zepto as a company"), so they
        // count only in capitals as registers write them.
        const legal = tail.match(/^,?\s+(?:inc|incorporated|llc|llp|ltd|limited|corp|corporation|plc|gmbh|pty|pvt|private\s+limited|pte|ltda|sdn\.?\s+bhd|bhd|p?jsc|ooo|oyj|aps|kft|zrt|sp\.?\s*z\s*o\.?\s*o|s\.\s?r\.\s?l|s\.\s?p\.\s?a|s\.\s?a\.\s?s|s\.\s?a\.?\s+de\s+c\.?\s?v|kabushiki\s+kaisha|sarl|sasu)\b\.?/i)
          || tail.match(/^,?\s+(?:AG|SA|S\.A\.|SAS|NV|BV|AB|AS|A\/S|ASA|Oy|OY|SE|KK|K\.K\.|GK|SpA|SPA|SRL|Srl|SL|S\.L\.|PJSC|JSC|OOO|Ltda|LTDA)(?![\p{L}\p{N}])\.?/u);
        if (legal) { add(s, e, 'strong', 'legal-form'); continue; }
        if (insideLongerName(text, s, e, f)) continue;
        if (!f.ordinary) { add(s, e, 'plain', 'name'); continue; }
        // An ordinary word: an article before it or a particle after it marks the word ("a Plaid shirt",
        // "The Notion that", "'The Ramp' church", "Ramp up", "Scale of the scheme").
        const prev = wordBefore(text, s) || (() => { const q = text.slice(0, s).match(/(\S+)\s*["“'‘]$/); return q ? { word: q[1], at: q.index } : null; })();
        if (prev && DETERMINERS.has(wordKey(prev.word))) continue;
        const nextWord = text.slice(e).match(/^[ \t]+([a-z]+)\b/);
        if (nextWord && VERB_PARTICLES.has(nextWord[1])) continue;
        const how = markerFor(text, s, e);
        if (how) add(s, e, 'marker', how);
      }
    }
    if (!spans.length) return empty;
    spans.sort((a, b) => a.start - b.start);
    const strength = spans.reduce((best, sp) => (STRENGTH_RANK[sp.strength] > STRENGTH_RANK[best] ? sp.strength : best), 'none');
    return { named: true, strength, spans };
  };
}

// ---------------------------------------------------------------------------
// Co-occurrence: the name and the company close together, about the same person.
// ---------------------------------------------------------------------------

/** Whether [start,end) is a whole field of a record written as fields ("Jane Roe; Acme; ..." or "Jane Roe | Acme | ..."). */
export function isWholeField(text, start, end) {
  const str = String(text || '');
  if (!/;\s|\s\|\s/.test(str)) return false;
  return /(?:^|;\s*|\s\|\s)$/.test(str.slice(0, start)) && /^(?:\s*;|\s\|\s|\s*$)/.test(str.slice(end));
}

export const SAME_SENTENCE_CHARS = 250;
export const ACROSS_SENTENCE_CHARS = 120;

const SENTENCE_BREAK = /[.!?]["”’)]*\s+(?=[\p{Lu}\p{N}"“(])|\n|\s[|•·]\s/u;
// "..., Jane Doe, CEO of " / "Jane Doe of " / "Jane Doe at ": another person's name just before the company.
const OTHER_BEFORE_COMPANY = /(\p{Lu}[\p{L}'’-]+\s+\p{Lu}[\p{L}'’-]+)(?:\s*,\s*(?:the\s+|a\s+|an\s+)?(?:[\p{L}-]+\s+){0,4}?|\s+)(?:of|at|from|with)\s+$/u;
// " CEO Patrick Collison", "'s founder Jane Doe": the company's role given to another person right after it.
// (No `i` flag: with it \p{Lu} would match lowercase letters too, and "Co-Founder with Fraud" would read as a name.)
const OTHER_AFTER_COMPANY = /^(?:['’]s)?\s+(?:[Cc]o-?[Ff]ounder|[Ff]ounder|CEO|CTO|CFO|COO|[Cc]hief\s+[Ee]xecutive(?:\s+[Oo]fficer)?|[Pp]resident|[Cc]hair(?:man|woman)?|[Hh]ead|[Bb]oss)\s*,?\s+(\p{Lu}[\p{L}'’-]+\s+\p{Lu}[\p{L}'’-]+)/u;
// "John Smith of Morgan Stanley", "John Smith, an analyst at Goldman": the name tied to another organisation.
const AFFILIATION_AFTER_NAME = /^(?:\s*,)?\s+(?:(?:an?|the)\s+)?(?:[\p{Ll}-]+\s+){0,3}?(?:of|at|from)\s+(?:the\s+)?(\p{Lu}[\p{L}&.'’-]*(?:\s+(?:\p{Lu}[\p{L}&.'’-]*|&|of|de)){0,4})/u;

/**
 * Is the company mention at `co` about the person named at `nm`?
 * The two must be in the same sentence (within SAME_SENTENCE_CHARS) or in neighbouring sentences
 * within ACROSS_SENTENCE_CHARS, and the company must not be given to another person in between.
 * @param {string} text
 * @param {{start:number,end:number}} nm  a name position
 * @param {{start:number,end:number}} co  a company span
 * @param {{ isSelf?: (s: string) => boolean, companySpans?: {start,end}[] }} opts
 */
export function nameNearCompany(text, nm, co, { isSelf = () => false, companySpans = [] } = {}) {
  const str = String(text || '');
  if (co.start < nm.end && nm.start < co.end) return true; // overlapping (a handle containing the company)
  // A structured record whose own field is the person's name ("Jane Roe | Acme Inc | ..."): a register or a
  // source that already matched the person by name; the whole record is about them.
  if (isWholeField(str, nm.start, nm.end)) {
    const m = str.slice(co.end, co.end + 80).match(OTHER_AFTER_COMPANY);
    return !(m && !isSelf(m[1]));
  }
  const companyFirst = co.end <= nm.start;
  const gapStart = companyFirst ? co.end : nm.end;
  const gapEnd = companyFirst ? nm.start : co.start;
  const gap = str.slice(gapStart, gapEnd);
  const crosses = SENTENCE_BREAK.test(gap);
  // The company's own address or handle (a page on its site, "@acme") ties the whole record to the company, so it
  // need not sit beside the name; the checks below still keep a name given to another organisation out.
  const address = co.how === 'domain' || co.how === 'address' || co.how === 'handle';
  if (!address && gap.length > (crosses ? ACROSS_SENTENCE_CHARS : SAME_SENTENCE_CHARS)) return false;
  // The name is tied to another organisation right after it ("John Smith of Morgan Stanley"): only a company
  // named before it in the same sentence can still be theirs ("Ex-Stripe engineer John Smith of Dublin").
  const aff = str.slice(nm.end, nm.end + 120).match(AFFILIATION_AFTER_NAME);
  if (aff) {
    const affStart = nm.end + aff.index + aff[0].length - aff[1].length;
    const affEnd = affStart + aff[1].length;
    const ours = [co, ...companySpans].some((sp) => sp.start >= affStart && sp.start < affEnd);
    if (!ours && (!companyFirst || crosses)) return false;
  }
  if (companyFirst) {
    const m = str.slice(co.end, nm.start + 1).match(OTHER_AFTER_COMPANY);
    if (m && !isSelf(m[1])) return false;
  } else {
    const m = gap.match(OTHER_BEFORE_COMPANY);
    if (m && !isSelf(m[1])) return false;
  }
  return true;
}

/**
 * Pairs of (name position, company span) that are about the same person.
 * @returns {{ name: {start,end}, company: {start,end,strength} }[]}
 */
export function cooccurrences(text, namePositions, companySpans, opts = {}) {
  const out = [];
  for (const nm of namePositions || []) {
    for (const co of companySpans || []) {
      if (nameNearCompany(text, nm, co, { ...opts, companySpans })) out.push({ name: nm, company: co });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Organisations too large to identify anyone by.
// ---------------------------------------------------------------------------

const BROAD_ORG_WORDS = /\b(universit(?:y|ies|é|ät|at|a)|college|school|institute\s+of\s+technology|polytechnic|academy|party|government|ministry|department\s+of|army|navy|air\s+force|marine\s+corps|parliament|congress|senate|house\s+of\s+representatives|association|society|federation|church|united\s+nations|european\s+union|world\s+bank|imf|nato|red\s+cross|ymca|boy\s+scouts|chamber\s+of\s+commerce|bar\s+of)\b/i;
const BROAD_ORG_NAMES = words(`harvard stanford mit yale princeton oxford cambridge berkeley columbia
google alphabet microsoft apple amazon meta facebook ibm oracle intel cisco walmart mckinsey deloitte pwc kpmg ey
accenture bain bcg goldman jpmorgan citigroup citi wells fargo general electric ge exxon chevron toyota samsung
nasa fbi cia`);
const BROAD_ORG_PHRASES = ['bank of america', 'morgan stanley', 'goldman sachs', 'wells fargo', 'general electric', 'jp morgan'];

/**
 * True for an organisation with thousands of members (a university, a party, a
 * government body, an association, a very large employer). Being linked to one
 * says nothing about which of many namesakes a record is about.
 */
export function isBroadOrganisation(name) {
  const s = String(name || '');
  if (BROAD_ORG_WORDS.test(s)) return true;
  const strict = companyKeyStrict(s);
  const loose = companyKeys(s)[0] || '';
  return BROAD_ORG_NAMES.has(strict) || BROAD_ORG_NAMES.has(loose) || BROAD_ORG_PHRASES.includes(strict);
}

// More employers with tens of thousands of staff. Kept apart from isBroadOrganisation, whose meaning other files
// rely on (which encyclopedia links and earlier employers count): this list only stops a typed company from
// confirming a record on its own.
const LARGE_EMPLOYER_NAMES = words(`nvidia tesla salesforce adobe sap siemens huawei alibaba tencent baidu bytedance netflix linkedin twitter uber dell
qualcomm broadcom sony panasonic hitachi honda ford volkswagen bmw bosch boeing lockheed raytheon pfizer merck novartis
roche unilever nestle pepsico costco kroger starbucks mcdonalds disney comcast verizon vodafone
infosys tcs wipro cognizant capgemini hcl
chase hsbc barclays ubs santander lloyds natwest rbc scotiabank blackrock vanguard fidelity schwab citibank`);
// Very large employers written in more than one word.
const LARGE_EMPLOYER_PHRASES = ['deutsche bank', 'credit suisse', 'bnp paribas', 'societe generale', 'charles schwab', 'ernst young', 'ernst & young',
  'tata consultancy services', 'johnson johnson', 'johnson & johnson', 'procter gamble', 'procter & gamble', 'home depot',
  'bank of new york mellon', 'state street', 'capital one', 'us bank', 'royal bank of canada', 'td bank', 'hewlett packard',
  'lockheed martin', 'mercedes benz', 'coca cola', 't mobile', 'at t', 'united health', 'unitedhealth group', 'kaiser permanente', 'boston consulting group', 'bain company'];

/**
 * True for an organisation so large that naming it beside a person's name does not single them out: every
 * isBroadOrganisation case, and other very large employers (Nvidia, Infosys, HSBC, Capital One...). A record that
 * names the person and only such a company is 'likely' at most until it gives a second fact.
 */
export function isLargeEmployer(name) {
  if (isBroadOrganisation(name)) return true;
  const strict = companyKeyStrict(name);
  const loose = companyKeys(name)[0] || '';
  return LARGE_EMPLOYER_NAMES.has(strict) || LARGE_EMPLOYER_NAMES.has(loose) || LARGE_EMPLOYER_PHRASES.includes(strict);
}

// ---------------------------------------------------------------------------
// A conflicting description beside the name ("John Smith, a Utah man", "John Smith, 45,").
// ---------------------------------------------------------------------------

const CONFLICT_AFTER_NAME = /^\s*,\s*(?:(?:an?\s+)?\d{2}(?:-year-old)?\s*,|an?\s+(?:\d{2}-year-old\s+)?\p{Lu}[\p{L}-]+\s+(?:man|woman|resident|native|teen|teenager|father|mother|dentist|doctor|nurse|teacher|pastor|farmer|driver|plumber|contractor|student|retiree)\b)/u;

// "John Smith, a Google engineer in Ohio,": an employee placed in a town or state, the way local news describes a
// staff member of a large employer, not a founder.
const LOCAL_EMPLOYEE_AFTER_NAME = /^\s*,\s*an?\s+(?:\d{2}-year-old\s+)?(?:former\s+)?(?:\p{Lu}[\p{L}&.'’-]*\s+){1,3}(?:[\p{Ll}-]+\s+)?(?:engineer|employee|worker|manager|analyst|developer|programmer|salesman|saleswoman|salesperson|accountant|clerk|technician|contractor|driver|associate|staffer|intern|cashier|supervisor|specialist|consultant|banker|teller|nurse|researcher|lecturer|professor)s?\s+(?:in|from|of|based\s+in)\s+\p{Lu}/u;

/** Does the text describe the person at `nm` in a way that marks someone ordinary and local ("a Utah man", "45,")? */
export function describedAsSomeoneElse(text, nm) {
  const after = String(text || '').slice(nm.end, nm.end + 120);
  return CONFLICT_AFTER_NAME.test(after) || LOCAL_EMPLOYEE_AFTER_NAME.test(after);
}

// ---------------------------------------------------------------------------
// How a legal matter ended, and the person's part in it.
// ---------------------------------------------------------------------------

// A span may not run past a turn in the sentence ("acquitted on two counts but convicted on four").
const SPAN = String.raw`(?:(?!\b(?:but|while|although|though|yet|however|whereas|convict\w*|guilty|sentenc\w*|indict\w*)\b)[^.;]){0,60}?`;
// The same, running to the end of the clause: what someone is acquitted of is part of the outcome.
const SPAN_TO_END = SPAN.replace(/\?$/, '');
const MATTER = String.raw`(?:lawsuits?|suits?|cases?|charges?|complaints?|claims?|indictments?|counts?|prosecutions?|proceedings?)`;
const RULING = String.raw`(?:convictions?|verdicts?|judgments?|sentences?|rulings?|findings?)`;
// Exculpatory outcomes, most telling first. A pardon is kept apart: it follows a conviction.
const OUTCOMES = [
  ['acquitted', new RegExp(String.raw`\b(?:acquit(?:s|ted|tal|ting)?\b${SPAN_TO_END}|found not guilty\b${SPAN_TO_END}|not[- ]guilty verdicts?\b|cleared of (?:all )?(?:criminal )?(?:charges|wrongdoing|fraud|allegations)\b)`, 'i')],
  ['overturned', new RegExp(String.raw`\b(?:${RULING}\b${SPAN}\b(?:overturned|reversed|thrown out|tossed)\b|(?:overturn(?:s|ed|ing)?|revers(?:es|ed|ing)|throws? out|threw out|toss(?:es|ed))\b${SPAN}\b${RULING})`, 'i')],
  ['vacated', new RegExp(String.raw`\b(?:${RULING}\b${SPAN}\bvacated\b|vacat(?:es|ed|ing)\b${SPAN}\b${RULING})`, 'i')],
  ['dismissed', new RegExp(String.raw`\b(?:${MATTER}\b${SPAN}\b(?:was|were|is|are|been|being|got|gets)?\s*dismissed\b|dismiss(?:es|ed|al of)\b${SPAN}\b${MATTER}|grant(?:s|ed)?\b${SPAN}\bmotions? to dismiss\b${SPAN})`, 'i')],
  ['dropped', new RegExp(String.raw`\b(?:${MATTER}\b${SPAN}\b(?:dropped|withdrawn|abandoned)\b|(?:drop(?:s|ped)?|withdr(?:aws?|ew))\b${SPAN}\b${MATTER})`, 'i')],
];
const PARDON = /\bpardon(?:s|ed|ing)?\b/i;
// "denies a motion to dismiss": a request to end the matter, not its end.
const DISMISS_REQUEST = /\b(?:den(?:y|ies|ied)|reject(?:s|ed)?|refus(?:es|ed))\b[^.;]{0,60}?\bmotions? (?:to|for) dismiss(?:al)?\b|\bmotions? (?:to|for) dismiss(?:al)?\b(?![^.;]{0,20}\bgranted\b)/gi;
const WON = new RegExp(String.raw`^[^.;]{0,30}?\b(?:wins?|won|prevail(?:s|ed)?\s+in)\b${SPAN}\b(?:${MATTER}|appeals?|trials?|arbitration|verdicts?|judgments?)\b`, 'i');

const DEFENDANT_BEFORE = /\b(?:against|sues?|sued|suing|charg(?:es|ed)|indict(?:s|ed)|convict(?:s|ed)|accus(?:es|ed)|arrest(?:s|ed)|fin(?:es|ed)|prosecut\w+|defendants?|investigat\w+|probes?)\s+(?:\S+\s+){0,2}$/i;
const DEFENDANT_AFTER = /^[^.;]{0,60}?\b(?:charged|indicted|convicted|arrested|sentenced|pleaded guilty|pled guilty|found guilty|accused|sued (?:by|over|for|in)\b|named (?:as )?(?:a )?defendant)/i;
const PLAINTIFF_AFTER = /^\s*(?:,[^,]{0,60},\s*)?(?:sues|is suing|has sued|filed (?:a |an )?(?:\w+ )?(?:lawsuit|suit|complaint|claim) against|brought (?:a |an )?(?:\w+ )?(?:lawsuit|suit|claim) against|sued (?=(?:his|her|their|the|a|an|former|ex-|\p{Lu})))/u;
const PLAINTIFF_NEAR = /^\s*,\s*(?:the|a)\s+plaintiff\b/i;
const WITNESS_AFTER = /^\s*(?:,\s*(?:a|the|another)\s+(?:\w+\s+)?witness\b|(?:testif(?:ied|ies|y)|appeared|was called|took the stand)\s+(?:as\s+(?:a\s+)?(?:\w+\s+)?witness|against|for the (?:prosecution|defen[cs]e)|in the (?:\S+\s+){0,3}trial of))/i;
const VICTIM_AFTER = /^\s*(?:,\s*(?:a|one|the|another)\s+(?:of the\s+)?(?:\w+\s+)?victims?\b|(?:was|is|were|became)\s+(?:a|one|among the|the|another)\s+(?:of the\s+)?(?:\w+\s+){0,2}?victims?\b)/i;
const JUROR_AFTER = /^\s*(?:,\s*(?:a|the)\s+juror\b|(?:was|served as)\s+(?:a\s+)?juror\b)/i;
const NON_PARTY_BEFORE = { plaintiff: /\bplaintiffs?\s+$/i, witness: /\bwitness(?:es)?\s+(?:\S+\s+)?$/i, victim: /\b(?:defrauded|scammed|victims?(?:\s+including)?)\s+$/i, juror: /\bjurors?\s+$/i };

/**
 * How a legal matter in the text ended, and the person's part in it, so a red flag can show its outcome and an
 * acquittal is never graded like a conviction.
 * @param {string} text
 * @param {{ person?: Function }} opts  person: a name matcher (personNameMatcher / nameMatcher); without it the
 *   part is not read, and 'won' (which needs to know who won) is not either.
 * @returns {{ outcome: 'acquitted'|'overturned'|'vacated'|'dismissed'|'dropped'|'won'|'pardoned'|null,
 *   role: 'defendant'|'plaintiff'|'witness'|'victim'|'juror'|null, phrase: string, rest: string }}
 *   phrase: the words that state the outcome; rest: the text without them (to see what else it reports).
 */
export function matterOutcome(text, { person = null } = {}) {
  const str = String(text || '');
  const t = str.replace(DISMISS_REQUEST, (m) => (/\bgranted\b/i.test(m) ? m : ' '));
  let outcome = null;
  let phrase = '';
  if (PARDON.test(t)) { outcome = 'pardoned'; phrase = t.match(PARDON)[0]; }
  for (const [name, re] of OUTCOMES) {
    if (outcome) break;
    const m = t.match(re);
    if (m) { outcome = name; phrase = m[0]; }
  }
  let role = null;
  const positions = person && typeof person.positions === 'function' ? person.positions(str) : [];
  if (positions.length) {
    const found = new Set();
    for (const p of positions) {
      const before = str.slice(Math.max(0, p.start - 60), p.start);
      const after = str.slice(p.end, p.end + 160);
      if (DEFENDANT_BEFORE.test(before) || DEFENDANT_AFTER.test(after)) found.add('defendant');
      if (PLAINTIFF_AFTER.test(after) || PLAINTIFF_NEAR.test(after) || NON_PARTY_BEFORE.plaintiff.test(before)) found.add('plaintiff');
      if (WITNESS_AFTER.test(after) || NON_PARTY_BEFORE.witness.test(before)) found.add('witness');
      if (VICTIM_AFTER.test(after) || NON_PARTY_BEFORE.victim.test(before)) found.add('victim');
      if (JUROR_AFTER.test(after) || NON_PARTY_BEFORE.juror.test(before)) found.add('juror');
      if (!outcome) {
        const w = after.match(WON);
        if (w) { outcome = 'won'; phrase = w[0]; }
      }
    }
    role = ['defendant', 'plaintiff', 'witness', 'victim', 'juror'].find((r) => found.has(r)) || null;
  }
  const rest = phrase ? t.replace(phrase, ' ') : t;
  return { outcome, role, phrase, rest };
}
