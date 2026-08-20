# Show and Tell Mirror — Online

מסמך תכנון מלא: ארכיטקטורה, מודל נתונים, מנוע חוקים, פרוטוקול רשת, UX, תוכנית בנייה ותוכנית בדיקות.

> **מה זה:** משחק אונליין לשני שחקנים לפורמט מותאם־אישית שבו **שני השחקנים משחקים בדיוק את אותו הדק** —
> דק Show and Tell / Omniscience חוקי ב־Timeless — בסדרות של **הטוב מ־3**, עם סיידבורד שנבנה
> אך ורק כנגד המירור, ו־"considering board" שמתחלף בין מאצ'ים.
>
> **העיקרון המנחה של כל המסמך:** מכיוון שמאגר הקלפים סגור וקטן (25 קלפים ייחודיים במיין, 6 בסייד),
> אנחנו **לא בונים מנוע MTG כללי**. אנחנו בונים מנוע שהוא *נכון לחלוטין* עבור 31 הקלפים האלה,
> עם פרימיטיבים כלליים שמאפשרים הרחבה. זה מוריד את היקף העבודה בסדר גודל ומאפשר להשקיע את
> רוב המאמץ במקום שבאמת חשוב: **נוחות המשחק**.

---

## תוכן עניינים

1. [הפורמט](#1-הפורמט)
2. [הדק — ניתוח מכני מלא](#2-הדק--ניתוח-מכני-מלא)
3. [החלטות ארכיטקטורה מפתח](#3-החלטות-ארכיטקטורה-מפתח)
4. [סטאק טכנולוגי ומבנה הפרויקט](#4-סטאק-טכנולוגי-ומבנה-הפרויקט)
5. [מודל הנתונים](#5-מודל-הנתונים)
6. [ליבת מנוע החוקים](#6-ליבת-מנוע-החוקים)
7. [מנגנון הבחירות + הבחירה הסימולטנית הסודית](#7-מנגנון-הבחירות--הבחירה-הסימולטנית-הסודית)
8. [אפקטים מתמשכים — שכבות מינימליות](#8-אפקטים-מתמשכים--שכבות-מינימליות)
9. [מנוע המאנה](#9-מנוע-המאנה)
10. [סקריפטים לקלפים](#10-סקריפטים-לקלפים)
11. [רשת: פרוטוקול, redaction, reconnect](#11-רשת-פרוטוקול-redaction-reconnect)
12. [UI/UX — נוחות המשחק](#12-uiux--נוחות-המשחק)
13. [זרימת מאצ' Bo3, סיידבורד ו־Considering Board](#13-זרימת-מאצ-bo3-סיידבורד-ו־considering-board)
14. [תוכנית בדיקות](#14-תוכנית-בדיקות)
15. [מטריצת האינטראקציות](#15-מטריצת-האינטראקציות)
16. [תוכנית בנייה בשלבים](#16-תוכנית-בנייה-בשלבים)
17. [סיכונים ומלכודות](#17-סיכונים-ומלכודות)
18. [נספחים](#18-נספחים)

---

## 1. הפורמט

### 1.1 חוקי בסיס

| פרמטר | ערך |
|---|---|
| שחקנים | 2 |
| חיים התחלתיים | 20 |
| גודל דק | 60 (מדויק — שני השחקנים, אותה רשימה) |
| סיידבורד | 15 |
| מוליגן | London Mulligan (שולפים 7, מחזירים N לתחתית) |
| מבנה מאצ' | Best-of-three |
| מי מתחיל | הגרלה במשחק 1; מפסיד המשחק הקודם בוחר play/draw |
| חוקיות | Timeless — אין banned; יש restricted (עותק אחד) |
| תנאי הפסד | חיים ≤ 0, שליפה מספרייה ריקה, 10 מוני הרעלה (לא רלוונטי כאן) |

**הערה על Timeless:** לפורמט אין רשימת banned; הוא מרסן כוח דרך **restriction** (עותק אחד בלבד).
`Demonic Tutor` נמצא ברשימה המוגבלת — מה שתואם את ה־`1 Demonic Tutor` בדק. יש לוודא את הרשימה
העדכנית בזמן הבנייה (ראו מקורות בסוף המסמך); ה־validator צריך לקרוא אותה מקובץ קונפיגורציה
ולא לקודד אותה קשיח.

### 1.2 הכלל הייחודי לפורמט הזה

שני השחקנים משחקים **את אותה רשימת 60 קלפים בדיוק**. זה לא חוק ששובר את המנוע — אבל הוא מכתיב
שלוש החלטות מוצר:

1. **זיהוי ויזואלי חד** בין הצדדים הוא קריטי (סעיף 12.4) — כי כל קלף על השולחן קיים פעמיים.
2. **ידע משותף מלא על התוכן** — שני השחקנים יודעים בדיוק מה יש בספרייה של היריב.
   המשחק כולו הוא משחק של **מידע חבוי על סדר וכמות**, לא על זהות. זה מכתיב את פיצ'ר
   ה־"Known Top of Library" (סעיף 12.6) כפיצ'ר מרכזי ולא כקישוט.
3. **ה־Considering Board** — מאגר שלישי שממנו מרכיבים את הסיידבורד בין מאצ'ים.
   דורש מודל נתונים של **סדרת מאצ'ים** ולא של משחק בודד (סעיף 13).

---

## 2. הדק — ניתוח מכני מלא

60 קלפים: **18 קרקעות** + 2 MDFC שמשמשים כקרקע (=20 מקורות קרקע אפקטיביים) + **42 ספלים**.

הנתונים המדויקים של כל הקלפים שמורים ב־[`data/oracle-cards.json`](data/oracle-cards.json)
(נמשך מ־Scryfall). **אל תקלידו טקסטים של קלפים ידנית** — טענו מהקובץ הזה.

### 2.1 טבלת יכולות שהמנוע חייב לתמוך בהן

| קלף | # | טקסט מכני | מה המנוע צריך |
|---|---|---|---|
| **Show and Tell** | 4 | Sorcery {2}{U}. כל שחקן *רשאי* לשים artifact/creature/enchantment/land מהיד לשדה | **בחירה סימולטנית סודית** + מעבר זונות בו־זמנית (§7.3) |
| **Omniscience** | 4 | Enchantment {7}{U}{U}{U}. אתה רשאי להטיל ספלים מהיד בלי לשלם עלות מאנה | **עלות חלופית** (alternative cost), לא הנחה |
| **Atraxa, Grand Unifier** | 4 | {3}{G}{W}{U}{B} 7/7 Flying/Vigilance/Deathtouch/Lifelink. ETB: חושף 10 עליונים, ל*כל סוג קלף* רשאי לקחת אחד ליד; השאר לתחתית **בסדר אקראי** | חשיפה פומבית, בחירה מרובה לפי `card type`, RNG דטרמיניסטי |
| **Mana Drain** | 4 | Instant {U}{U}. מבטל ספל; **בתחילת הפייז הראשי הבא שלך** הוסף {C} כמספר ה־MV שלו | delayed trigger + **LKI** של MV + mana pool שנשפך בסוף הפייז |
| **Brainstorm** | 4 | Instant {U}. שלוף 3, החזר 2 לראש הספרייה בסדר לבחירתך | 3 אירועי draw נפרדים + סידור ראש ספרייה |
| **Dig Through Time** | 4 | Instant {6}{U}{U}, **Delve**. הצץ ב־7, 2 ליד, השאר לתחתית בסדר לבחירתך | Delve כהפחתת עלות גנרית + הגליה מבית קברות |
| **Assemble the Team** | 4 | Sorcery {B}{G}. חפש ב**שליש העליון של הספרייה, מעוגל למעלה**, קלף ליד, ערבב | חיפוש ב**תת־קבוצה מחושבת דינמית** של זונה חבויה |
| **Rakshasa's Bargain** | 3 | Instant {2/B}{2/G}{2/U} (**MV=6**). הצץ ב־4, 2 ליד, השאר **לבית הקברות** | עלויות היברידיות (2 או צבע) + חישוב MV נכון |
| **Orcish Bowmasters** | 2 | {1}{B} 1/1 **Flash**. ETB *וגם* בכל פעם שיריב שולף קלף **פרט לראשון בכל draw step שלו** — 1 נזק ל־any target, ואז **Amass Orcs 1** | ספירת draws לפי step, טריגר מרובה, Amass (טוקן Army 0/0 + מוני +1/+1) |
| **Planar Genesis** | 2 | Instant {G}{U}. הצץ ב־4; רשאי לשים **קרקע לשדה מוטה**; אחרת קלף ליד; השאר לתחתית אקראית | הכנסת קרקע לשדה **בלי land drop** |
| **Veil of Summer** | 2 | Instant {G}. שלוף קלף אם יריב הטיל ספל כחול/שחור השנה; ספלים שלך **לא ניתנים לביטול** השנה; אתה והקבועים שלך מקבלים **hexproof from blue and from black** | היסטוריית הטלות לפי צבע/תור + "can't be countered" + `hexproof from [quality]` |
| **Waterlogged Teachings** // **Inundated Archive** | 2 | **MDFC**. פנים: Instant {3}{U/B} — חפש **instant או קלף עם flash**. גב: Land נכנס מוטה, {T}: {U} או {B} | תמיכה ב־MDFC + **CR 712.8a** (בזונה שאינה שדה/סטאק — רק הפן הקדמי!) |
| **Hullbreaker Horror** | 1 | {5}{U}{U} 7/8 **Flash**, **לא ניתן לביטול**. בכל פעם שאתה מטיל ספל, בחר **עד אחד** — החזר ספל שאינך שולט בו ליד / החזר קבוע לא־קרקע ליד | טריגר על cast, יכולת **מודאלית "up to one"**, החזרת ספל מהסטאק |
| **Borne Upon a Wind** | 1 | Instant {1}{U}. אתה רשאי להטיל ספלים השנה כאילו יש להם **flash**. שלוף קלף | היתר תזמון גורף (**לא** חל על קרקעות!) |
| **Demonic Tutor** | 1 | Sorcery {1}{B}. חפש בספרייה קלף ליד, ערבב | חיפוש בזונה חבויה |
| **Mystic Sanctuary** | 1 | Land — Island. נכנס מוטה אלא אם אתה שולט ב־**3+ Islands אחרים**. כשנכנס **לא מוטה** — רשאי לשים instant/sorcery מבית הקברות שלך על ראש הספרייה | ספירת **land subtype** (לא שם!), טריגר עם תנאי מתערב |
| **Mistrise Village** | 1 | Land. נכנס מוטה אלא אם אתה שולט ב־Mountain או **Forest**. {T}: {U}. {U},{T}: **הספל הבא** שתטיל השנה לא ניתן לביטול | תנאי כניסה לפי subtype + אפקט "הספל הבא" חד־פעמי |
| **Flooded Strand** | 4 | {T}, שלם 1 חיים, הקרב: חפש **Plains או Island**, לשדה, ערבב | fetch לפי subtype + עלות חיים + ערבוב |
| **Polluted Delta** | 4 | {T}, שלם 1 חיים, הקרב: חפש **Island או Swamp**, לשדה, ערבב | כנ"ל |
| **Breeding Pool** | 2 | Land — Forest Island. **As it enters** רשאי לשלם 2 חיים; אחרת נכנס מוטה | **replacement effect** בכניסה |
| **Watery Grave** | 2 | Land — Island Swamp. כנ"ל | כנ"ל |
| **Hallowed Fountain** | 1 | Land — Plains Island. כנ"ל | כנ"ל |
| **Hedge Maze** | 1 | Land — Forest Island. נכנס מוטה. ETB: **Surveil 1** | surveil |
| **Undercity Sewers** | 1 | Land — Island Swamp. נכנס מוטה. ETB: **Surveil 1** | surveil |
| **Island** | 1 | Basic Land — Island | — |

### 2.2 קווי המשחק המרכזיים (מה שהמנוע חייב לבצע נכון)

```
A) Show and Tell → Omniscience → הכל בחינם → Atraxa → מכה
B) Show and Tell → Atraxa ישירות (turn 1-2 עם fetch/shock)
C) Mana Drain על Rakshasa's Bargain (MV=6!) → 6 מאנה חסרת־צבע בפייז הראשי → Omniscience קשה
D) Borne Upon a Wind → Show and Tell ב־end step של היריב (sorcery במהירות instant)
E) Omniscience + Hullbreaker Horror → כל הטלה חינמית מחזירה ספל/קבוע של היריב = נעילה
F) Show and Tell נותן ליריב Omniscience גם כן → מרוץ פריוריטי; ה־AP מקבל פריוריטי ראשון
G) Waterlogged Teachings מחפש Hullbreaker Horror / Orcish Bowmasters (יש להם flash!)
```

> ⚠️ **קו E הוא הסיבה שהמנוע חייב `hold priority`** — בלעדיו כל הטלה חינמית מחייבת סבב פריוריטי.

### 2.3 בסיס המאנה — למה ה־auto-tapper חייב להיות פותר אמיתי

| צבע | מקורות בדק |
|---|---|
| **U** | כל 18 הקרקעות (למעט Flooded Strand/Polluted Delta שהן fetch) + Inundated Archive |
| **B** | Watery Grave ×2, Undercity Sewers ×1, Inundated Archive ×2 |
| **G** | Breeding Pool ×2, Hedge Maze ×1 |
| **W** | Hallowed Fountain ×1 |
| **C** | Mana Drain (מושהה) |

`Assemble the Team` דורש **{B}{G}** — כלומר גם שחור וגם ירוק, כששני הצבעים מגיעים מקרקעות
דו־צבעיות שמייצרות גם כחול. אלגוריתם חמדני יטה את Breeding Pool ל־{U} וייתקע.
👉 **חובה matching/backtracking** (§9.3), לא greedy.

---

## 3. החלטות ארכיטקטורה מפתח

| # | החלטה | נימוק |
|---|---|---|
| **A1** | **שרת סמכותי (authoritative server)** — הלקוח לעולם לא מחזיק את ה־state המלא | Brainstorm, Show and Tell, surveil, חיפושים. ידיעת סדר הספרייה = ניצחון מובטח. redaction בצד שרת היא **דרישת נכונות**, לא אופטימיזציה |
| **A2** | **Event-sourced + seeded PRNG** — כל אקראיות מגיעה מ־PRNG ששמור ב־state | replay חינם, בדיקות דטרמיניסטיות, "Lab mode", דיבוג של באגים נדירים |
| **A3** | **מנוע טהור** (`packages/engine`) בלי I/O, בלי רשת, בלי זמן | ניתן לבדוק ב־ms, ניתן להריץ fuzzing של אלפי משחקים, ניתן להריץ גם בלקוח לצורך אנימציות/תחזיות |
| **A4** | **Generators (`function*`) לסקריפטי קלפים** | פתרון ספל עם 4 בחירות עוקבות נקרא כמו הטקסט של הקלף במקום כמכונת מצבים |
| **A5** | **TypeScript מקצה לקצה + חבילת `protocol` משותפת** | טיפוסי הפרוטוקול נאכפים בקומפילציה בשני הצדדים |
| **A6** | **בלי מערכת שכבות (613) מלאה** — רק `RuleModifier` + 7d counters + 6 ability-granting | מאגר הקלפים לא צריך יותר. הוספת שכבה נוספת בעתיד = הרחבה נקודתית |
| **A7** | **`hasAnyLegalAction()` כאזרח מדרגה ראשונה במנוע** | הבסיס ל־auto-pass, שהוא **פיצ'ר הנוחות מספר 1** |
| **A8** | **Undo בצד שרת** דרך snapshot לפני כל פעולה, עם "safe window" | פורמט אימון־מירור; take-back הוא ערך אדיר. אפשרי רק בזכות A2 |

---

## 4. סטאק טכנולוגי ומבנה הפרויקט

### 4.1 סטאק

| שכבה | בחירה | הערה |
|---|---|---|
| שפה | **TypeScript 5.x** (strict) | |
| חבילה | **npm יחיד** עם תיקיות מופרדות | ראו הערת הסטייה מתחת לעץ התיקיות |
| מנוע | TS טהור, state משתנה + snapshots | `structuredClone`/JSON לצילומי מצב; פשוט יותר מ־Immer ומספיק מהיר |
| שרת | **Node 22** + `ws` (WebSocket גולמי) | Socket.IO מיותר; אין צורך ב־fallbacks |
| התמדה | **SQLite** (better-sqlite3) | לוגי מאצ'ים, replays, פרופילים |
| לקוח | **React 19 + Vite** | |
| State בלקוח | **Zustand** | פשוט, בלי boilerplate |
| אנימציה | **Framer Motion** | `layoutId` למעברי זונות — קריטי ל"נעים" |
| גרירה | **@dnd-kit/core** | |
| בדיקות | **Vitest** (יחידה) + **Playwright** (שני דפדפנים) | |
| Property tests | **fast-check** | |
| תמונות קלפים | Scryfall CDN, cached | ראו §17.5 (רישוי) |

### 4.2 מבנה תיקיות

```
mtg-show-and-tell-mirror/
├── DESIGN.md                      ← המסמך הזה
├── data/
│   ├── oracle-cards.json          ← נתוני Scryfall קפואים (25 קלפים)
│   ├── decklist.json              ← 60 מיין + 15 סייד
│   └── format.json                ← restricted list, גודל דק, חיים
├── src/
│   ├── engine/                    ← טהור: בלי רשת, בלי DOM, בלי זמן
│   │   ├── types.ts               ← GameState, CardInstance, Choice*, Event*
│   │   ├── rng.ts                 ← xoshiro128** עם seed בתוך ה־state
│   │   ├── oracle.ts              ← טוען את data/oracle-cards.json ומפרסר type lines
│   │   ├── state.ts               ← זונות, מאפיינים, שאילתות
│   │   ├── mana.ts                ← פרסור עלויות + פותר התשלום
│   │   ├── effects.ts             ← hexproof-from / can't-be-countered / flash
│   │   ├── script-types.ts        ← ה־DSL: Ctx, CardScript, Ability
│   │   ├── game.ts                ← לולאת התור, פריוריטי, סטאק, SBA, קרב
│   │   ├── redact.ts              ← GameState → PlayerView
│   │   ├── deck.ts                ← טוען את הדק
│   │   ├── cards/                 ← סקריפטים, מקובצים לפי תפקיד
│   │   │   ├── index.ts           ← הרישום
│   │   │   ├── lands.ts           ├ 9 קרקעות
│   │   │   ├── cantrips.ts        ├ Brainstorm, Dig, Bargain, Planar, Borne
│   │   │   ├── tutors.ts          ├ Demonic, Assemble, Waterlogged
│   │   │   ├── combo.ts           ├ Show and Tell, Omniscience
│   │   │   ├── creatures.ts       ├ Atraxa, Hullbreaker, Bowmasters
│   │   │   └── interaction.ts     └ Mana Drain, Veil of Summer
│   │   └── __tests__/
│   │       ├── harness.ts         ← ה־DSL לבדיקות
│   │       ├── bot.ts             ← בוט אקראי ל־fuzzing ולבדיקת דטרמיניזם
│   │       ├── show-and-tell.test.ts
│   │       ├── omniscience.test.ts
│   │       ├── interaction.test.ts
│   │       ├── cards.test.ts
│   │       ├── mana.test.ts
│   │       ├── redaction.test.ts
│   │       └── invariants.test.ts
│   ├── protocol/                  ← טיפוסי ההודעות המשותפים
│   ├── server/                    ← lobby, match runner, WebSocket
│   └── client/                    ← React
```

> **סטייה מודעת מהתכנון המקורי:** במקום pnpm workspaces עם ארבע חבילות, זו חבילת npm
> אחת עם הפרדה ברורה בתיקיות. `npm install && npm run dev` עובד מיד, ואין שכבת build
> שצריך לתחזק. ההפרדה הלוגית נשמרה במלואה — `src/engine` לא מייבא כלום מ־`src/client`
> או מ־`src/server`. באותו אופן, סקריפטי הקלפים מקובצים לפי תפקיד (6 קבצים) במקום
> קובץ לכל קלף (25 קבצים); הרישום ב־`cards/index.ts` נשאר נקודת הכניסה היחידה.


---

## 5. מודל הנתונים

### 5.1 טיפוסי ליבה

```ts
// packages/protocol/src/state.ts

export type PlayerId = 'p1' | 'p2';
export type IID = number;            // instance id — ייחודי לכל קלף פיזי במשחק
export type OracleId = string;       // 'show_and_tell', 'atraxa_grand_unifier', ...

export type ZoneName =
  | 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'stack';

export interface CardInstance {
  iid: IID;
  oracleId: OracleId;
  owner: PlayerId;
  controller: PlayerId;           // שונה מ־owner רק בתאוריה כאן, אבל נשמור נכון
  zone: ZoneName;
  /** מיקום בתוך הזונה. עבור library: 0 = ראש הספרייה. */
  index: number;

  // מאפייני שדה קרב
  tapped: boolean;
  summoningSick: boolean;
  damage: number;
  counters: Record<string, number>;   // { '+1/+1': 3 }
  /** עבור MDFC: איזה פן שוחק. null = פן קדמי / לא רלוונטי */
  face: 'front' | 'back' | null;
  /** טוקנים (Orc Army) */
  isToken: boolean;
  tokenSpec?: TokenSpec;

  // מאפייני סטאק
  stackTargets?: TargetRef[];
  stackModes?: number[];
  castWithoutPayingMana?: boolean;   // Omniscience — משפיע על Delve, על LKI, ועל ה־UI
  delvedIids?: IID[];
}

export interface PlayerState {
  id: PlayerId;
  life: number;
  landDropsUsed: number;
  landDropsAllowed: number;         // 1 כברירת מחדל
  manaPool: ManaPool;
  /** היסטוריית התור — נדרש ל־Veil of Summer ול־Orcish Bowmasters */
  turnLog: {
    spellsCast: { iid: IID; oracleId: OracleId; colors: Color[]; mv: number }[];
    drawsThisTurn: number;
    drawsThisDrawStep: number;
  };
  hasConceded: boolean;
  lostReason?: 'life' | 'deck-out' | 'concede';
}

export interface GameState {
  gameId: string;
  seed: RngState;                    // ← כל אקראיות נגזרת מכאן
  turnNumber: number;
  activePlayer: PlayerId;
  priorityPlayer: PlayerId | null;   // null = בפתרון ספל
  phase: Phase;
  step: Step | null;
  cards: Record<IID, CardInstance>;
  players: Record<PlayerId, PlayerState>;
  /** IIDs לפי סדר — התחתון של המערך = תחתית הסטאק */
  stack: IID[];
  /** טריגרים שממתינים להיכנס לסטאק */
  pendingTriggers: PendingTrigger[];
  /** אפקטים מתמשכים פעילים */
  effects: ActiveEffect[];
  /** יכולות מושהות: Mana Drain, Mistrise Village */
  delayedTriggers: DelayedTrigger[];
  /** הבחירה שהמנוע ממתין לה כרגע (אם יש) */
  pendingChoice: ChoiceRequest | null;
  /** ספירת פאסים רצופים — 2 = הסטאק נפתר / הצעד מסתיים */
  consecutivePasses: number;
  winner: PlayerId | 'draw' | null;
}
```

### 5.2 למה `index` בתוך הזונה ולא מערכים

שמירת סדר הספרייה כשדה על ה־`CardInstance` (במקום כמערך נפרד) הופכת כל מעבר זונה לפעולה
אחת, ומאפשרת ל־`redact()` פשוט למחוק את השדה. חסרון: צריך `reindex(zone)` אחרי כל שינוי.
**חלופה מומלצת אם מעדיפים בהירות:** `zones: Record<PlayerId, Record<ZoneName, IID[]>>`
כמערכים מסודרים, ו־`CardInstance` בלי `index`. שתי הגישות עובדות; בחרו אחת ואל תערבבו.

### 5.3 נתוני Oracle (סטטי, לא ב־state)

```ts
export interface OracleCard {
  oracleId: OracleId;
  name: string;
  manaCost: string | null;         // '{2}{U}'
  mv: number;                      // Rakshasa's Bargain = 6
  typeLine: string;
  types: CardType[];               // ['Sorcery'] — נדרש ל־Atraxa
  subtypes: string[];              // ['Island','Swamp'] — נדרש ל־fetch ול־Mystic Sanctuary
  supertypes: string[];            // ['Legendary','Basic']
  colors: Color[];
  power?: string; toughness?: string;
  keywords: string[];
  producedMana: Color[];
  layout: 'normal' | 'modal_dfc';
  faces?: OracleCard[];            // MDFC
  imageUri: string;
}
```

> **CR 712.8a — קריטי:** קלף דו־פני מודאלי בזונה שאינה שדה־הקרב או הסטאק מחזיק **רק את
> מאפייני הפן הקדמי**. לכן `Waterlogged Teachings` ביד הוא **Instant, לא Land** —
> ולכן **אי אפשר לבחור בו ל־Show and Tell**, והוא נספר כ־instant ב־Atraxa.
> זו טעות שכמעט כל מימוש ביתי עושה. יש לה בדיקה ייעודית (§15).

---

## 6. ליבת מנוע החוקים

### 6.1 מבנה התור

```
Beginning:   Untap → Upkeep → Draw
Main 1
Combat:      Begin Combat → Declare Attackers → Declare Blockers → Combat Damage → End of Combat
Main 2
Ending:      End Step → Cleanup
```

**לא לקצר את הקרב.** Atraxa 7/7 טס/deathtouch/lifelink היא תנאי הניצחון בפועל, ומשחקי מירור
נחתכים על בלוקים (Atraxa חוסמת Atraxa; ה־deathtouch הופך כל חילוף לקטלני; ה־lifelink הופך
מרוצים). ה־Orc Army מ־Bowmasters הוא בלוקר לגיטימי.

### 6.2 הלולאה הראשית

```ts
function advance(state: GameState): GameState {
  // 1. אם יש בחירה פתוחה — עצור, המתן לתשובה
  if (state.pendingChoice) return state;

  // 2. פעולות מבוססות־מצב (SBA) — נבדקות שוב ושוב עד יציבות
  while (applyStateBasedActions(state)) { /* חוזר עד שאין שינוי */ }

  // 3. טריגרים ממתינים → לסטאק בסדר APNAP
  if (state.pendingTriggers.length) { putTriggersOnStack(state); return state; }

  // 4. פריוריטי
  if (state.priorityPlayer === null) {
    state.priorityPlayer = state.activePlayer;
    state.consecutivePasses = 0;
  }

  // 5. אם שני השחקנים העבירו:
  if (state.consecutivePasses >= 2) {
    if (state.stack.length) resolveTop(state);
    else advanceStep(state);
  }
  return state;
}
```

### 6.3 SBA שנדרשות למאגר הקלפים הזה

| SBA | CR | רלוונטיות |
|---|---|---|
| שחקן עם ≤0 חיים מפסיד | 704.5a | fetch+shock, Bowmasters, Atraxa |
| שחקן שניסה לשלוף מספרייה ריקה מפסיד | 704.5b | Brainstorm על ספרייה של 2 |
| יצור עם toughness ≤0 נשלח לבית קברות | 704.5f | טוקן Army 0/0 בלי מונים |
| יצור עם נזק ≥ toughness מת | 704.5g | קרב |
| יצור שנפגע מ־deathtouch מת | 704.5h | Atraxa vs Atraxa |
| **חוק האגדות** | 704.5j | שני Atraxa אצל **אותו** שולט. שני Atraxa אצל **שולטים שונים** — חוקי לגמרי! |
| ספל/יכולת בלי מטרות חוקיות — פוקע | 608.2b | Mystic Sanctuary עם בית קברות ריק |

### 6.4 טריגרים

```ts
export interface PendingTrigger {
  sourceIid: IID;
  controller: PlayerId;
  abilityId: string;
  /** מידע שנלכד ברגע הטריגר (LKI) */
  context: Record<string, unknown>;
}
```

- טריגרים נאספים כשהאירוע קורה, ונכנסים לסטאק **בפעם הבאה ששחקן יקבל פריוריטי**.
- סדר: כל הטריגרים של ה־AP קודם (בסדר שהוא בוחר), ואז של ה־NAP (בסדר שהוא בוחר).
- **מקרה מבחן חובה:** שני `Orcish Bowmasters` + `Brainstorm` של היריב = **6 טריגרים**
  (3 draws × 2 bowmasters), כולם צריכים סידור ומיקוד מטרות.
- ⚠️ **דרישת UX נגזרת:** 6 פרומפטים ברצף זה בלתי־נסבל → ראו `TriggerPolicy` ב־§12.7.

### 6.5 מטרות (targeting)

```ts
export type TargetRef =
  | { kind: 'player'; id: PlayerId }
  | { kind: 'permanent'; iid: IID }
  | { kind: 'spell'; iid: IID }          // Mana Drain, Hullbreaker Horror
  | { kind: 'cardInGraveyard'; iid: IID }; // Mystic Sanctuary
```

מטרות נבחרות **בזמן ההטלה** ונבדקות שוב **בזמן הפתרון**. ספל שכל מטרותיו נעשו לא־חוקיות
פוקע (fizzle) ולא עושה כלום. `hexproof from blue/black` של Veil of Summer בודקת חוקיות
בשני הרגעים.

---

## 7. מנגנון הבחירות + הבחירה הסימולטנית הסודית

### 7.1 למה generators

פתרון של `Atraxa` דורש: חשיפת 10 → בחירה לכל סוג קלף → סידור השאר. פתרון של `Brainstorm`
דורש: שליפה ×3 → בחירת 2 → סידור. מכונת מצבים לזה היא סיוט. Generator נקרא כמו הקלף:

```ts
// packages/engine/src/cards/brainstorm.ts
export const brainstorm: CardScript = {
  oracleId: 'brainstorm',
  timing: 'instant',
  *resolve(ctx) {
    for (let i = 0; i < 3; i++) ctx.draw(ctx.controller);   // 3 אירועי draw נפרדים!

    const chosen = yield* ctx.chooseCards({
      player: ctx.controller,
      from: ctx.hand(ctx.controller),
      count: 2,
      ordered: true,                     // "in any order" — הסדר משנה
      prompt: 'החזר 2 קלפים לראש הספרייה (הראשון = הכי עליון)',
    });
    ctx.moveToLibraryTop(chosen);        // chosen[0] יהיה הקלף העליון
  },
};
```

ה־`ctx.draw()` בלולאה מנפיק **שלושה אירועי `DrawEvent` נפרדים** — וזה בדיוק מה שגורם
ל־Orcish Bowmasters לטרגר שלוש פעמים. אם תממשו את זה כ־`drawN(3)`, האינטראקציה הכי חשובה
בדק תישבר בשקט.

### 7.2 מנגנון ההרצה

```ts
type Resolution = Generator<ChoiceRequest, void, ChoiceResponse>;

class ResolutionRunner {
  private gen: Resolution | null = null;

  /** מריץ עד לבחירה הבאה או עד הסוף */
  pump(state: GameState, response?: ChoiceResponse): void {
    const r = response ? this.gen!.next(response) : this.gen!.next();
    state.pendingChoice = r.done ? null : withId(r.value);
  }
}
```

**התמדה ו־replay:** ה־generator חי בזיכרון השרת בלבד. ה־**source of truth** הוא
`actionLog: (Intent | ChoiceResponse)[]` + ה־seed. טעינה מחדש = הרצת הלוג מאפס.
בגלל A2 (seeded RNG) התוצאה זהה ביט־בביט. זה גם מה שנותן replay ו־undo בחינם.

### 7.3 ⭐ Show and Tell — הבחירה הסימולטנית הסודית

**זה המנגנון שמגדיר את הפורמט. אם הוא לא נכון — המשחק שבור.**

**החוק:** לפי CR 101.4, כששחקנים מרובים מבצעים בחירות במהלך פתרון, ה־AP בוחר ראשון ואז ה־NAP —
אבל **בחירת קלף מהיד אינה חשיפה**. הקלפים נשארים ביד עד שהם נכנסים לשדה **בו־זמנית**.
לכן ה־NAP אינו לומד מה ה־AP בחר.

**המימוש:**

```ts
export const showAndTell: CardScript = {
  oracleId: 'show_and_tell',
  timing: 'sorcery',
  *resolve(ctx) {
    const picks = yield* ctx.simultaneousSecretChoice({
      players: ['p1', 'p2'],
      request: (p) => ({
        kind: 'optionalCardFromHand',
        player: p,
        filter: (c) => hasAnyType(c, ['Artifact', 'Creature', 'Enchantment', 'Land']),
        optional: true,                     // "may" — לשים כלום זה חוקי
        prompt: 'בחר artifact / creature / enchantment / land לשים לשדה',
      }),
    });

    // מעבר בו־זמני — לא לולאה עם ETB באמצע!
    ctx.moveSimultaneously(
      Object.entries(picks).filter(([, iid]) => iid !== null)
                           .map(([p, iid]) => ({ iid: iid!, to: 'battlefield' })),
    );
    // הטריגרים של שני ה־ETB נאספים יחד ונכנסים לסטאק ב־APNAP
  },
};
```

**דרישות מהמימוש — כל אחת מהן היא באג קריטי אם מפרים אותה:**

| # | דרישה | מה נשבר אם לא |
|---|---|---|
| 1 | השרת **לא משדר** את בחירת ה־AP עד ששני השחקנים נעלו | ה־NAP רואה את הבחירה ומנצח |
| 2 | ה־`PlayerView` של היריב מקבל רק `opponentLockedIn: boolean` | דליפת מידע |
| 3 | הקלפים נכנסים לשדה **בו־זמנית** (`moveSimultaneously`) | `Hedge Maze` ETB יטרגר לפני שהקלף השני נכנס; `Mystic Sanctuary` יספור לא נכון |
| 4 | טריגרי ה־ETB של שניהם נאספים יחד ואז נכנסים לסטאק ב־APNAP | סדר טריגרים שגוי |
| 5 | ל־Omniscience אין ETB, ל־Atraxa יש — הטריגר של Atraxa נפתר **אחרי** ששניהם בשדה | Atraxa "תראה" מצב שגוי |
| 6 | `Waterlogged Teachings` **אינו** בחירה חוקית (§5.3) | קלף לא־חוקי נכנס לשדה |
| 7 | הבחירה נעולה — אין undo אחרי `lockIn` | take-back = רמאות |

**אנטי־רמאות:** מאחר שהשרת הוא סמכותי ומהימן — אין צורך בקריפטו. **אם** מישהו ירצה מצב
P2P ללא שרת בעתיד, המנגנון הוא **commit–reveal**: כל שחקן שולח `SHA256(iid ‖ nonce)`,
ואחרי ששניהם commit — כל אחד חושף `iid ‖ nonce`. שווה לתעד כנקודת הרחבה, לא לממש עכשיו.

### 7.4 קטלוג סוגי הבחירות

| `kind` | משמש ב־ |
|---|---|
| `optionalCardFromHand` | Show and Tell |
| `chooseCards` (count, ordered, min/max) | Brainstorm, Dig Through Time, Atraxa, Rakshasa's Bargain |
| `searchLibrary` (filter, subset) | Demonic Tutor, Assemble the Team, Waterlogged Teachings, fetchlands |
| `chooseTargets` | Bowmasters, Mana Drain, Hullbreaker Horror, Mystic Sanctuary |
| `chooseMode` (up to N) | Hullbreaker Horror |
| `yesNo` | shocklands (2 חיים), surveil, Planar Genesis |
| `orderTriggers` | טריגרים מרובים |
| `payMana` | הטלה ידנית |
| `simultaneousSecretChoice` | **Show and Tell בלבד** |

---

## 8. אפקטים מתמשכים — שכבות מינימליות

אין צורך במערכת 613 מלאה. נדרשים בדיוק ארבעה סוגי אפקטים:

```ts
export type ActiveEffect =
  // 1. מוני +1/+1 (שכבה 7d) — Amass
  | { kind: 'counters'; /* נגזר מ־card.counters, לא צריך רשומה */ }

  // 2. הענקת יכולת (שכבה 6) — Veil of Summer
  | { kind: 'grantAbility';
      ability: 'hexproof-from-blue' | 'hexproof-from-black';
      /** ⚠️ ננעל בזמן הפתרון! "אתה והקבועים שאתה שולט" = הרשימה ברגע הפתרון */
      affected: { players: PlayerId[]; iids: IID[] };
      expires: 'endOfTurn' }

  // 3. שינוי חוק — לא ניתן לביטול
  | { kind: 'ruleModifier'; rule: 'spells-cant-be-countered';
      controller: PlayerId;
      scope: 'all-this-turn'      // Veil of Summer
           | 'next-spell'         // Mistrise Village
      ; consumed?: boolean;
      expires: 'endOfTurn' }

  // 4. היתר תזמון / עלות
  | { kind: 'castPermission';
      permission: 'as-though-flash'          // Borne Upon a Wind
                | 'without-paying-mana-cost' // Omniscience (סטטי מהקבוע)
      ; controller: PlayerId;
      expires: 'endOfTurn' | 'while-source-on-battlefield';
      sourceIid?: IID }
```

**נקודות עדינות:**

- **`Veil of Summer` — `affected` ננעל בזמן הפתרון.** קבוע שנכנס לשדה *אחרי* Veil אינו
  מקבל hexproof. ✅ בדיקה חובה.
- **`Veil of Summer` — "spells you control can't be countered this turn"** כן חל על ספלים
  שתטיל **מאוחר יותר** באותו תור. ⚠️ שני חלקים של אותו קלף עם התנהגות הפוכה — מלכודת קלאסית.
- **`hexproof from blue and from black`** (CR 702.11d) = לא ניתן להיות מטרה של ספלים כחולים/שחורים
  של יריבים, **או של יכולות של יריבים ממקורות כחולים/שחורים**.
  → `Orcish Bowmasters` (מקור שחור) לא יכול למקד אותך או את הקבועים שלך. ✅
  → `Hullbreaker Horror` (מקור כחול) לא יכול להחזיר את הקבועים שלך. ✅
- **`Mistrise Village`** — `consumed` מסומן ברגע שהטלת ספל, לא בסוף התור. אם לא הטלת ספל,
  האפקט ממשיך לחכות עד סוף התור.
- **`Omniscience`** אינו `ActiveEffect` שמור ב־state אלא **נגזר** מנוכחות הקבוע בשדה.
  אם Hullbreaker Horror מחזיר אותו ליד באמצע הרצף — היכולת נעלמת מיד. ✅ בדיקה חובה.

---

## 9. מנוע המאנה

### 9.1 עלויות

```ts
export type CostSymbol =
  | { t: 'generic'; n: number }
  | { t: 'colored'; c: Color }
  | { t: 'hybrid-generic'; n: number; c: Color };  // {2/B} — Rakshasa's Bargain
```

**MV של סמל היברידי־גנרי** = הגבוה מבין האפשרויות. `{2/B}{2/G}{2/U}` → 2+2+2 = **6**.
זה משנה ישירות כמה מאנה `Mana Drain` נותן. ✅ בדיקה חובה.

### 9.2 Mana Pool

```ts
export interface ManaPool { W: number; U: number; B: number; R: number; G: number; C: number; }
```

- ה־pool מתרוקן **בסוף כל צעד ובסוף כל פייז** (CR 500.4). אין mana burn.
- `Mana Drain` מוסיף בתחילת **הפייז הראשי הבא שלך** — כלומר המאנה זמינה לאורך כל הפייז הראשי
  ומתרוקנת בסופו.
- 👉 דרישת UX: **המאנה הצפה חייבת להיות בלתי־ניתנת להחמצה** (§12.5).

### 9.3 ה־Auto-Tapper — פותר, לא חמדן

**הבעיה:** `Assemble the Team` = `{B}{G}`. מקורות G: Breeding Pool, Hedge Maze (שניהם גם U).
מקורות B: Watery Grave, Undercity Sewers (שניהם גם U). אלגוריתם חמדני שיטה Breeding Pool
ל־U ייתקע.

**הפתרון:** מודלים כ־**bipartite matching** עם backtracking. גודל הבעיה זעיר (≤10 קרקעות),
אז חיפוש ממצה מספיק.

```ts
interface ManaSource { iid: IID; produces: Color[]; extraCost?: 'life-1'; }

/** מחזיר תוכנית תשלום, או null אם לא ניתן לשלם */
function solvePayment(
  cost: CostSymbol[],
  sources: ManaSource[],
  pool: ManaPool,
  opts: {
    /** קרקעות שהשחקן ביקש לשמור — למשל Mistrise Village ליכולת שלה */
    reserved: IID[];
    /** האם מותר לשלם חיים (fetch) */
    allowLifePayment: boolean;
    /** העדפה: להשאיר כמה שיותר גמישות צבעונית לתור */
    objective: 'maximize-remaining-flexibility';
  },
): PaymentPlan | null
```

**כללי ההיוריסטיקה של ה־objective** (משנים המון בתחושת המשחק):
1. השתמש קודם ב־pool צף (מאנת Mana Drain הולכת לאיבוד בסוף הפייז!).
2. שמור מקורות עם *הכי מעט* אפשרויות צבע לאחרונה? **לא** — הפוך: **הטה קודם את המקורות
   הכי מוגבלים** (Island בסיסי לפני Breeding Pool).
3. אל תטה `Mistrise Village` אם היכולת שלה עדיין לא נוצלה השנה ויש חלופה.
4. אל תשלם חיים אם יש חלופה בלי חיים; מתחת ל־6 חיים — שאל תמיד.

---

## 10. סקריפטים לקלפים

### 10.1 ה־Interface

```ts
export interface CardScript {
  oracleId: OracleId;
  timing?: 'instant' | 'sorcery';
  /** בדיקות חוקיות נוספות מעבר לתזמון ולעלות */
  canCast?(ctx: Ctx): boolean;
  /** עלויות נוספות / מודאליות בזמן ההטלה */
  onCast?(ctx: Ctx): Resolution;
  /** מטרות חוקיות */
  targets?: TargetSpec[];
  /** גוף הפתרון */
  resolve?(ctx: Ctx): Resolution;
  /** יכולות סטטיות/מופעלות/מותנות בשדה */
  abilities?: Ability[];
  /** אפקט החלפה בכניסה — shocklands */
  asEnters?(ctx: Ctx): Resolution;
}
```

### 10.2 דוגמאות לקלפים הקשים

<details>
<summary><b>Orcish Bowmasters</b> — הטריגר הכי מסובך בדק</summary>

```ts
export const orcishBowmasters: CardScript = {
  oracleId: 'orcish_bowmasters',
  abilities: [
    {
      kind: 'triggered',
      // טריגר מאוחד: ETB או draw של יריב
      on: (ev, self, state) => {
        if (ev.type === 'entersBattlefield' && ev.iid === self.iid) return true;
        if (ev.type === 'draw' && ev.player !== self.controller) {
          const p = state.players[ev.player];
          const isDrawStep = state.step === 'draw' && state.activePlayer === ev.player;
          // "פרט לראשון שהוא שולף בכל draw step שלו"
          return !(isDrawStep && p.turnLog.drawsThisDrawStep === 1);
        }
        return false;
      },
      targets: [{ kind: 'anyTarget' }],   // שחקן / יצור / planeswalker / battle
      *resolve(ctx) {
        ctx.dealDamage({ source: ctx.self, target: ctx.targets[0], amount: 1 });
        yield* ctx.amass(ctx.controller, 'Orc', 1);
      },
    },
  ],
};

/** CR 701.44 — Amass */
function* amass(ctx: Ctx, player: PlayerId, type: string, n: number): Resolution {
  let army = ctx.battlefield(player).find((c) => hasSubtype(c, 'Army'));
  if (!army) army = ctx.createToken(player, { pt: '0/0', colors: ['B'], subtypes: [type, 'Army'] });
  else ctx.addSubtype(army, type);
  ctx.addCounters(army, '+1/+1', n);
}
```

**מלכודות:**
- הנזק והמיקוד קורים **בפתרון**, לא בטריגר. אם ה־Bowmasters מת בינתיים — הטריגר עדיין נפתר
  (`ctx.self` = LKI).
- `drawsThisDrawStep` חייב להתאפס בתחילת כל draw step.
- שני Bowmasters + Brainstorm של היריב = 6 טריגרים. הטוקן נוצר פעם אחת, ואז 5 מונים.
- `Veil of Summer` ביריב חוסם את המיקוד (מקור שחור). הטריגר עדיין עולה לסטאק, אבל אם אין
  מטרה חוקית — הוא מוסר מהסטאק ו**גם ה־Amass לא קורה** (הטריגר כולו פוקע). ✅ בדיקה חובה.
</details>

<details>
<summary><b>Hullbreaker Horror</b> — יכולת מודאלית על כל הטלה</summary>

```ts
export const hullbreakerHorror: CardScript = {
  oracleId: 'hullbreaker_horror',
  timing: 'instant',                    // Flash
  cantBeCountered: true,
  abilities: [
    {
      kind: 'triggered',
      on: (ev, self) => ev.type === 'spellCast' && ev.controller === self.controller,
      *resolve(ctx) {
        const mode = yield* ctx.chooseMode({
          upTo: 1,                       // "choose up to one" — אפס זה חוקי
          modes: [
            { id: 0, text: 'החזר ספל שאינך שולט בו ליד בעליו',
              targets: [{ kind: 'spell', filter: (s) => s.controller !== ctx.controller }] },
            { id: 1, text: 'החזר קבוע לא־קרקע ליד בעליו',
              targets: [{ kind: 'permanent', filter: (p) => !isLand(p) }] },
          ],
        });
        if (mode === null) return;       // בחר כלום
        ctx.moveToHand(ctx.targets[0]);  // עובד גם על ספל מהסטאק — הוא לא נפתר
      },
    },
  ],
};
```

**מלכודות:**
- הטלת ה־Horror עצמו **אינה** מטרגרת אותו — הוא עדיין לא בשדה.
- החזרת ספל מהסטאק ליד = הספל לא נפתר. שונה מ־counter (חשוב מול `Veil of Summer`
  ומול Mistrise Village — הם מגנים מ־**ביטול**, לא מהחזרה!). ✅ בדיקה חובה — זו הדרך
  לשבור את ההגנות במירור.
- עם `Omniscience`, כל הטלה חינמית מטרגרת. Horror מול Horror = מלחמת החזרות.
- ⚠️ **UX:** בלי `TriggerPolicy` (§12.7) זה 15 פרומפטים בתור.
</details>

<details>
<summary><b>Omniscience</b> — עלות חלופית</summary>

```ts
export const omniscience: CardScript = {
  oracleId: 'omniscience',
  abilities: [{
    kind: 'static',
    grants: { castPermission: 'without-paying-mana-cost', from: 'hand', controller: 'self' },
  }],
};
```

**מלכודות (כל אחת = בדיקה):**
| # | כלל | |
|---|---|---|
| 1 | **קרקעות אינן ספלים** — אי אפשר "להטיל" קרקע בחינם | ✅ |
| 2 | **מגבלות תזמון נשארות** — Show and Tell עדיין sorcery־speed בלבד | ✅ זו הסיבה ל־Borne Upon a Wind |
| 3 | **Delve הופך לחסר משמעות** — אין עלות גנרית לצמצם. ה־UI צריך לדלג על הפרומפט | ✅ |
| 4 | **סמלים היברידיים** של Rakshasa's Bargain — לא רלוונטיים | ✅ |
| 5 | אם Omniscience עוזב את השדה באמצע התור — ההיתר נעלם **מיד** | ✅ |
| 6 | עלויות נוספות (additional costs) עדיין משולמות — אין כאלה בדק, אבל הקוד צריך להיות נכון | |
</details>

<details>
<summary><b>Assemble the Team</b> — חיפוש בתת־קבוצה דינמית</summary>

```ts
export const assembleTheTeam: CardScript = {
  oracleId: 'assemble_the_team',
  timing: 'sorcery',
  *resolve(ctx) {
    const lib = ctx.library(ctx.controller);
    const n = Math.ceil(lib.length / 3);           // "top third, rounded up"
    if (n === 0) return;                            // ספרייה ריקה — כלום, אבל עדיין מערבבים
    const found = yield* ctx.searchZone({
      player: ctx.controller,
      cards: lib.slice(0, n),                       // ← רק השליש העליון
      count: 1, optional: true,                     // "for a card" — מותר לא למצוא
      prompt: `חפש בין ${n} הקלפים העליונים`,
    });
    if (found) ctx.moveToHand(found);
    ctx.shuffle(ctx.controller);                    // ← תמיד, גם אם לא נמצא
  },
};
```
| גודל ספרייה | שליש עליון |
|---|---|
| 53 | 18 |
| 40 | 14 |
| 10 | 4 |
| 1 | 1 |
| 0 | 0 |
</details>

<details>
<summary><b>Fetchlands + Shocklands</b></summary>

```ts
export const floodedStrand: CardScript = {
  oracleId: 'flooded_strand',
  abilities: [{
    kind: 'activated',
    cost: { tap: true, life: 1, sacrificeSelf: true },
    *resolve(ctx) {
      const found = yield* ctx.searchZone({
        player: ctx.controller,
        cards: ctx.library(ctx.controller),
        filter: (c) => hasSubtype(c, 'Plains') || hasSubtype(c, 'Island'),
        count: 1, optional: true,                   // "may fail to find"
      });
      if (found) ctx.moveToBattlefield(found);      // ← עובר דרך asEnters של השוק!
      ctx.shuffle(ctx.controller);
    },
  }],
};

export const breedingPool: CardScript = {
  oracleId: 'breeding_pool',
  *asEnters(ctx) {                                   // אפקט החלפה — אי אפשר להגיב
    const pay = yield* ctx.yesNo(ctx.controller, 'לשלם 2 חיים כדי שייכנס לא מוטה?');
    if (pay) ctx.loseLife(ctx.controller, 2); else ctx.enterTapped();
  },
};
```

**טבלת ה־fetch המלאה בדק הזה:**

| קרקע | subtypes | Flooded Strand (Plains/Island) | Polluted Delta (Island/Swamp) |
|---|---|:---:|:---:|
| Island | Island | ✅ | ✅ |
| Breeding Pool | Forest Island | ✅ | ✅ |
| Hallowed Fountain | Plains Island | ✅ | ✅ |
| Watery Grave | Island Swamp | ✅ | ✅ |
| Undercity Sewers | Island Swamp | ✅ | ✅ |
| Hedge Maze | Forest Island | ✅ | ✅ |
| Mystic Sanctuary | Island | ✅ | ✅ |
| **Mistrise Village** | — | ❌ | ❌ |
| Inundated Archive | — (וגם לא קרקע בספרייה) | ❌ | ❌ |

> 💡 שתי ה־fetch **זהות פונקציונלית בדק הזה**. שווה להציג את זה ב־UI (למשל טולטיפ
> "8 fetchlands זהים") כדי לחסוך לשחקן חישוב מיותר.
</details>

<details>
<summary><b>Veil of Summer</b> — שלושה אפקטים בקלף אחד</summary>

```ts
export const veilOfSummer: CardScript = {
  oracleId: 'veil_of_summer',
  timing: 'instant',
  *resolve(ctx) {
    // 1. שליפה מותנית — "if an opponent HAS CAST" (כבר קרה השנה)
    const opp = ctx.opponent(ctx.controller);
    const castBlueOrBlack = ctx.state.players[opp].turnLog.spellsCast
      .some((s) => s.colors.includes('U') || s.colors.includes('B'));
    if (castBlueOrBlack) ctx.draw(ctx.controller);   // ← מטרגר Bowmasters של היריב!

    // 2. "can't be countered THIS TURN" — כולל ספלים עתידיים
    ctx.addEffect({ kind: 'ruleModifier', rule: 'spells-cant-be-countered',
                    controller: ctx.controller, scope: 'all-this-turn', expires: 'endOfTurn' });

    // 3. hexproof — ⚠️ נעילת הרשימה ברגע הפתרון בלבד
    ctx.addEffect({ kind: 'grantAbility', ability: 'hexproof-from-blue',
                    affected: { players: [ctx.controller], iids: ctx.battlefieldIids(ctx.controller) },
                    expires: 'endOfTurn' });
    ctx.addEffect({ kind: 'grantAbility', ability: 'hexproof-from-black', /* ... */ });
  },
};
```

**האינטראקציה החשובה ביותר בפורמט:**
`Veil of Summer` הופך את `Mana Drain` ×4 של היריב לקלף מת לתור שלם, ובנוסף חוסם את
`Orcish Bowmasters` ואת `Hullbreaker Horror` ממיקוד. הוא **לא** עוצר את
`Hullbreaker Horror` מלהחזיר **ספל** שלך מהסטאק — כי הספל אינו "אתה או קבוע שאתה שולט".
✅ זו בדיקה קריטית ומפתיעה.
</details>

---

## 11. רשת: פרוטוקול, redaction, reconnect

### 11.1 הודעות

```ts
// לקוח → שרת
export type Intent =
  | { t: 'playLand'; iid: IID; face?: 'front' | 'back' }
  | { t: 'castSpell'; iid: IID; targets?: TargetRef[]; modes?: number[];
      payment?: PaymentPlan | 'auto' | 'free'; holdPriority?: boolean }
  | { t: 'activateAbility'; iid: IID; abilityIndex: number; targets?: TargetRef[] }
  | { t: 'passPriority' }
  | { t: 'autoPassUntil'; marker: 'endOfTurn' | 'myNextTurn' | 'off' }
  | { t: 'respondChoice'; choiceId: string; payload: unknown }
  | { t: 'declareAttackers'; iids: IID[] }
  | { t: 'declareBlockers'; assignments: Record<IID, IID> }
  | { t: 'undo' } | { t: 'concede' }
  | { t: 'setTriggerPolicy'; policy: TriggerPolicy };

// שרת → לקוח
export type ServerMsg =
  | { t: 'view'; view: PlayerView; events: GameEvent[]; seq: number }
  | { t: 'choice'; request: RedactedChoiceRequest }
  | { t: 'opponentLockedIn' }              // ← Show and Tell בלבד
  | { t: 'matchState'; match: MatchState }
  | { t: 'error'; message: string };
```

### 11.2 Redaction — ליבת האנטי־רמאות

```ts
export function redact(state: GameState, viewer: PlayerId): PlayerView {
  const opp = other(viewer);
  return {
    ...publicFields(state),
    hands: {
      [viewer]: state.hand(viewer),          // מלא
      [opp]:    { count: state.hand(opp).length },   // ← ספירה בלבד
    },
    libraries: {
      // ⚠️ אף פעם לא לשלוח סדר. גם לא של עצמך —
      // הלקוח לומד את הראש מהאירועים בלבד (Brainstorm/surveil).
      [viewer]: { count: n(viewer) },
      [opp]:    { count: n(opp) },
    },
    graveyards: full(),   // בית קברות = מידע פומבי, וקריטי ל־delve
    exile: full(),
    battlefield: full(),
    stack: state.stack.map(redactStackObject),
    // בחירה סודית פתוחה — רק דגל
    secretChoice: state.pendingChoice?.kind === 'simultaneousSecretChoice'
      ? { opponentLockedIn: isLocked(state, opp) }
      : null,
  };
}
```

**כלל ברזל:** `redact()` בונה אובייקט חדש מאפס. **אסור** לעשות `{...state}` ואז `delete`.
`delete` נשכח; בנייה מפורשת לא.

### 11.3 Reconnect ו־Undo

- לכל מאצ' יש `actionLog` מתמיד ב־SQLite + `seed`.
- **Reconnect:** השרת מריץ את הלוג מחדש (מהיר — משחק ממוצע < 500 פעולות), שולח `view` מלא.
- **Undo:** snapshot לפני כל `Intent` של שחקן. חוקי אם ורק אם, מאז ה־snapshot:
  1. היריב לא קיבל שום מידע חדש, **וגם**
  2. לא נצרך RNG (ערבוב, Atraxa bottom, הגרלה), **וגם**
  3. לא נחשף לך מידע חבוי חדש (surveil, Brainstorm, חיפוש).

  אחרת ה־undo נדחה עם הודעה מסבירה. במצב **Practice** (מוסכם בין השחקנים) — undo חופשי
  בהסכמת שני הצדדים.

---

## 12. UI/UX — נוחות המשחק

> **זה הסעיף החשוב ביותר במסמך.** מנוע נכון זה תנאי הכרחי; נוחות זה המוצר.
> הפורמט מיועד למאות משחקים חוזרים בין אותם שני שחקנים — כל חיכוך מוכפל פי מאה.

### 12.1 עשרת עקרונות היסוד

1. **אף פעם אל תשאל שאלה שיש לה תשובה אחת.** אם ל־Bowmasters יש מטרה חוקית אחת ואתה
   בהגדרות "auto-target when unambiguous" — פשוט בחר.
2. **אף פעם אל תיתן פריוריטי כשאין מה לעשות.** `hasAnyLegalAction()` → auto-pass.
3. **כל פעולה הפיכה עד שהיא לא.** Undo נדיב, עם הודעה ברורה כשזה נחסם.
4. **מידע שראית נשאר גלוי לך.** אם עשית Brainstorm — הלקוח זוכר את ראש הספרייה.
5. **מקלדת לפני עכבר.** כל פעולה נגישה במקש.
6. **הסטאק תמיד קריא.** ויזואליזציה אנכית עם מטרות מסומנות בקווים.
7. **אין הפתעות שקטות.** כל שינוי מצב מקבל אנימציה + שורת לוג.
8. **המירור צריך צבע.** שני צדדים זהים = חובה בידול ויזואלי חזק.
9. **מהירות > אפקט.** אנימציות ≤ 200ms, וניתנות לכיבוי מוחלט.
10. **המסך לא זז מתחת ליד.** בלי layout shift; מיקומים קבועים לכל זונה.

### 12.2 פריסת המסך

```
┌──────────────────────────────────────────────────────────────┐
│  יריב: 20♥  יד: 5  ספרייה: 47  gy: 3  [אווטאר + צבע מבדיל]  │
├─────────────┬────────────────────────────────────┬───────────┤
│             │      שדה היריב (יצורים/קסמים)      │  הסטאק    │
│  לוג        ├────────────────────────────────────┤  ▔▔▔▔     │
│  משחק       │      קרקעות היריב                  │  [ספל 2]  │
│  (מקופל)    ├════════════ קו אמצע ═══════════════┤  [ספל 1]  │
│             │      הקרקעות שלי  [מאנה צפה: ⓒⓒⓒ] │           │
│             ├────────────────────────────────────┤  ▁▁▁▁     │
│             │      השדה שלי                      │  ראש ספר' │
├─────────────┴────────────────────────────────────┴───────────┤
│           היד שלי  (מסומנת FREE כש־Omniscience פעיל)          │
├──────────────────────────────────────────────────────────────┤
│  20♥  ספרייה: 46  [F2 העבר] [F6 עד סוף התור] [⟲ Undo]        │
└──────────────────────────────────────────────────────────────┘
```

### 12.3 ⭐ Auto-Pass — פיצ'ר הנוחות מספר 1

```ts
interface StopSettings {
  /** תמיד עצור בפייז הראשי שלי אם יש לי משהו לעשות */
  myMainPhase: boolean;                      // ברירת מחדל: true
  /** עצור כשיש ספל על הסטאק שאני יכול להגיב לו */
  opponentSpellOnStack: 'always' | 'if-i-have-answer' | 'never';  // ברירת מחדל: if-i-have-answer
  /** עצור לפני declare attackers/blockers */
  combat: boolean;                           // ברירת מחדל: true
  /** עצור ב־end step של היריב אם יש לי instant/flash */
  opponentEndStep: 'if-i-have-instant' | 'always' | 'never';      // ברירת מחדל: if-i-have-instant
  /** החזקת Ctrl בזמן פאס = כפה עצירה בכל נקודה בתור הבא */
  forceStopModifier: boolean;
}
```

**`if-i-have-answer` הוא הפיצ'ר הגדול בדק הזה.** ה־engine כבר יודע לחשב
`hasAnyLegalAction()` — אז הוא יכול לענות "האם יש לך Mana Drain/Veil/Bowmasters/
Hullbreaker שאתה יכול להטיל עכשיו?" ולעצור **רק** אז. זה חוסך 80% מהעצירות.

> ⚠️ **דליפת מידע דרך auto-pass:** אם המערכת עוצרת רק כשיש לך תשובה, היריב לומד מהקצב
> שיש לך תשובה. **פתרון:** ה־auto-pass מבוצע בשרת עם **השהיה אקראית קבועה (150–400ms)
> בכל נקודת פריוריטי**, כך שהזמן אינו אינפורמטיבי. חובה. זו טעות שיש ב־MTGO.

### 12.4 בידול המירור

מכיוון ששני השחקנים משחקים אותה רשימה, קלף על השולחן לא מזוהה לפי זהותו:

- **מסגרת צבע לכל קבוע** לפי שולט (למשל: אני = טורקיז, יריב = ענבר). לא רק על הקלף —
  גם הרקע של חצי השולחן מקבל גוון עדין.
- **ה"קו האמצעי"** קבוע ובולט; המפה **לעולם לא מתהפכת** גם לא באנימציות.
- **תגי מקור בכל שורת לוג:** `[אני] Show and Tell` / `[יריב] Show and Tell`.
- כשיש שני `Atraxa` בשדה (חוקי! שולטים שונים) — כל אחת עם המסגרת שלה, ובנוסף
  אינדיקטור "×2 בשדה" כדי למנוע בלבול.

### 12.5 מאנה

- **Auto-tap כברירת מחדל** בלחיצה על קלף, עם ה־solver מ־§9.3.
- **Manual override:** לחיצה על קרקעות *לפני* בחירת הקלף → ה־solver משתמש רק במה שהוטה.
- **Shift+לחיצה** על קלף → פתיחת חלון תשלום ידני מלא.
- **מאנה צפה (Mana Drain) = אלמנט ענק ומהבהב** מעל הקרקעות שלך:
  `⚡ {C}{C}{C}{C}{C}{C} — נעלם בסוף הפייז הראשי`. עם ספירה לאחור ויזואלית כשעוברים פייז.
- **אזהרה לפני איבוד מאנה:** מעבר פייז עם מאנה צפה → דיאלוג אישור חד־פעמי
  ("יש לך 6 מאנה צפה — להמשיך?"). ניתן לכיבוי.
- **תגי עלות בהיר/כהה:** קלף שאפשר להטיל עכשיו = בוהק; אי אפשר = מעומעם עם סיבה בטולטיפ
  ("חסר {G}" / "רק בפייז ראשי").

### 12.6 ⭐ מעקב "ראש הספרייה הידוע"

**הפיצ'ר שאף לקוח אונליין לא עושה טוב, והוא קריטי בדק עם 4 Brainstorm.**

וידג'ט צד־לקוח (מידע שהשחקן ראה לגיטימית) שמראה:

```
📚 ראש הספרייה שלי — ידוע:
   1. Omniscience        ← מ־Brainstorm, לפני 2 תורות
   2. Flooded Strand     ← מ־Brainstorm
   3. ???
   ⚠️ נמחק אוטומטית בערבוב הבא
```

- מתעדכן מ־`Brainstorm`, `Surveil`, `Planar Genesis`, `Dig Through Time` (תחתית),
  `Mystic Sanctuary`, `Atraxa`.
- **מתאפס אוטומטית** על כל אירוע `shuffle` (fetch, tutor, Assemble the Team).
- נשמר גם אחרי reconnect (מאוחסן ב־localStorage לפי `gameId`).
- **חשוב:** זה **לא** דליפת מידע — זה זיכרון של מה שהשחקן כבר ראה. השרת עדיין לא שולח
  את סדר הספרייה; הלקוח בונה את הרשימה מאירועי החשיפה שהוא קיבל.

### 12.7 ⭐ מדיניות טריגרים — פותרת את בעיית ה־Hullbreaker

**הבעיה:** `Omniscience` + `Hullbreaker Horror` = 10–20 הטלות בתור, כל אחת עם פרומפט
"choose up to one". זה הורג את המשחק.

```ts
interface TriggerPolicy {
  hullbreaker:
    | 'ask-always'
    | 'auto-none'                          // תמיד "עד אפס"
    | 'auto-bounce-opponent-spell'         // אם יש ספל של היריב על הסטאק — החזר אותו; אחרת כלום
    | 'auto-bounce-best';                  // היוריסטיקה: ספל > Omniscience יריב > Atraxa יריב
  bowmasters: 'ask-always' | 'auto-target-opponent-face' | 'auto-if-unambiguous';
  /** זכור סידור טריגרים זהים */
  rememberTriggerOrder: boolean;
  /** מקש קיצור להשעיית המדיניות לטריגר הבא */
  overrideKey: 'Alt';
}
```

**ה־UI:** סרגל צף בזמן ה"קומבו טורן" —
`Hullbreaker: [כלום ▾]  Bowmasters: [פני היריב ▾]  (Alt = שאל אותי)`.
כך אפשר "לרוץ" את התור בלחיצות רצופות ולעצור נקודתית.

### 12.8 ⭐ מצב Omniscience

כשיש לך `Omniscience` בשדה, ה־UI **משנה מצב**:

- כל הקלפים ביד מקבלים תג `FREE` במקום עלות המאנה, והקלפים שעדיין לא ניתן להטיל
  (sorceries מחוץ לפייז ראשי) מעומעמים עם הסבר.
- **`Borne Upon a Wind` מקבל הדגשה מיוחדת** כשאתה לא בפייז ראשי — כי הוא הפותח.
- **מונה הטלות בתור:** `הוטלו השנה: 7` — קריטי בגלל טריגרי Hullbreaker.
- **Hold Priority דולק אוטומטית** במצב Omniscience (עם אפשרות כיבוי), כדי שרצף
  ההטלות לא ייקטע.
- **"שרשרת מהירה":** לחיצה על קלף → מוטל → הלוג מתעדכן → הפוקוס חוזר ליד. בלי דיאלוגים.

### 12.9 ⭐ מסך ה־Show and Tell

הרגע המכונן של הפורמט מקבל UI ייעודי:

```
┌────────── SHOW AND TELL ──────────┐
│                                   │
│   🔒 היריב נעל את הבחירה           │  ← או "⏳ היריב בוחר..."
│                                   │
│   בחר קלף לשים לשדה:              │
│   ┌────┐ ┌────┐ ┌────┐            │
│   │Omni│ │Atra│ │Isle│  [ללא]     │  ← רק בחירות חוקיות מוצגות
│   └────┘ └────┘ └────┘            │
│   (Waterlogged Teachings מעומעם   │
│    — MDFC ביד הוא instant)        │
│                                   │
│         [ נעל בחירה ]             │  ← לא הפיך!
└───────────────────────────────────┘
```

ואז **אנימציית חשיפה סימולטנית**: שני הקלפים מתהפכים יחד באמצע המסך, עצירה של 800ms,
ואז נעים לשדות בו־זמנית. זו הדרמה של הפורמט — שווה להשקיע בה.

**פרטים:**
- קלפים לא־חוקיים **מוצגים אך מעומעמים** עם הסבר (למידה, ומניעת בלבול).
- אין טיימר כברירת מחדל. אופציונלי: 60 שניות עם התראה.
- אחרי הנעילה — כפתור Undo מושבת מפורשות עם הסבר.

### 12.10 קיצורי מקלדת

| מקש | פעולה |
|---|---|
| `Space` / `F2` | העבר פריוריטי פעם אחת |
| `F6` | העבר עד סוף התור |
| `F8` | העבר עד התור הבא שלי |
| `Ctrl` + פאס | כפה עצירה בנקודת הפריוריטי הבאה |
| `1`–`9` | הטל/שחק קלף מהיד לפי מיקום |
| `Shift` + קלף | תשלום מאנה ידני |
| `Alt` | עקוף `TriggerPolicy` לטריגר הבא |
| `H` | החזק פריוריטי (hold) |
| `Ctrl+Z` | Undo |
| `L` | פתח/סגור לוג מלא |
| `T` | הצג את "ראש הספרייה הידוע" |
| `Esc` | בטל בחירה נוכחית |

### 12.11 לוג ו־Replay

- לוג טקסטואלי מלא, מסונן (`הכל` / `ספלים` / `נזק` / `זונות`), עם **ריחוף על שורה
  מדגיש את הקלף** בשדה.
- **Replay מלא** לכל משחק (בזכות A2). נגן עם timeline, מהירות, וקפיצה לרגעי מפתח
  ("כל ה־Show and Tell", "כל ה־Mana Drain").
- ⭐ **Lab Mode:** בתוך replay, "פצל מכאן" — יוצר משחק חדש מהמצב הזה, שבו אתה שולט
  בשני הצדדים, כדי לחקור קווים. **זה הפיצ'ר שהופך את האפליקציה לכלי אימון** ולא רק למשחק,
  והוא בדיוק מה שפורמט "endless mind games" צריך.

### 12.12 נגישות ופרטים קטנים שעושים הבדל

- ריחוף על קלף → תצוגה מוגדלת בפינה קבועה (לא tooltip שקופץ).
- לחיצה ימנית על קלף → תפריט: "הצג טקסט מלא", "הצג רולינגס", "הצג את כל העותקים בזונות".
- כל המספרים (חיים, ספרייה, יד) עם אנימציית ספירה — קל לקלוט שינוי.
- מצב "ידיים גדולות" — כשיש 10+ קלפים ביד היד נפרשת בשתי שורות במקום להצטמצם.
- תמיכה מלאה ב־light/dark.
- **חיווי "מי מחכה למי"** תמיד גלוי: `⏳ ממתין ליריב` / `➤ תורך`.

---

## 13. זרימת מאצ' Bo3, סיידבורד ו־Considering Board

### 13.1 המודל התלת־שכבתי

לפי תיאור הפורמט, יש **שלושה** מאגרים:

```ts
interface FormatPools {
  maindeck: CardCount[];        // 60 — קבוע, זהה לשני השחקנים
  sideboard: CardCount[];       // 15 — נבחר מתוך considering, זהה בתחילת סדרה
  considering: CardCount[];     // מאגר גדול יותר — ממנו מרכיבים סיידבורד בין מאצ'ים
}
```

- **בתוך מאצ' (בין משחק 1 ל־2, ובין 2 ל־3):** מותר להחליף בין maindeck ל־sideboard
  (כללי MTG רגילים — הדק חייב לחזור ל־60 ולא לרדת מ־60).
- **בין מאצ'ים:** מותר לשנות את הרכב ה־15 של הסיידבורד מתוך ה־considering board.
- **המלצת הפורמט:** לפחות 4 מאצ'ים ללא סיידבורד ("game-1 only") לפני שמתחילים
  להשתמש ב־considering board. → **האפליקציה תאכוף/תציע את זה** דרך `SeriesSettings`.

### 13.2 מכונת המצבים של הסדרה

```
      ┌─────────────┐
      │   LOBBY     │  בחירת יריב, הגדרות סדרה
      └──────┬──────┘
             ▼
      ┌─────────────┐
      │ SERIES_SETUP│  בחירת 15 סיידבורד מתוך considering (אם מותר)
      └──────┬──────┘
             ▼
      ┌─────────────┐
      │  DIE_ROLL   │  הגרלה → הזוכה בוחר play/draw
      └──────┬──────┘
             ▼
   ┌─────────────────┐
   │    MULLIGAN     │  London, שני השחקנים במקביל
   └────────┬────────┘
            ▼
   ┌─────────────────┐
   │      GAME       │  ←──────────────────┐
   └────────┬────────┘                     │
            ▼                              │
   ┌─────────────────┐   לא הוכרעה         │
   │  GAME_RESULT    │───────► ┌───────────┴────────┐
   └────────┬────────┘         │   SIDEBOARDING     │
            │ הוכרעה           │ (המפסיד בוחר       │
            ▼                  │  play/draw)        │
   ┌─────────────────┐         └────────────────────┘
   │  MATCH_RESULT   │
   └────────┬────────┘
            ▼
   ┌─────────────────┐
   │   SERIES_LOG    │  ← ⭐ המטא־טרקר
   └─────────────────┘
```

### 13.3 ⭐ מסך הסיידבורדינג

- שתי רשתות זו לצד זו: **מיין (60)** ו־**סייד (15)**, גרירה דו־כיוונית.
- מונה חי: `מיין: 60 ✅` / `מיין: 58 ❌ (חסרים 2)`.
- **`[אותו הדבר כמו במשחק הקודם]`** — כפתור אחד. חוסך המון.
- **`[הצג מה שיחקתי במשחק 1]`** — רשימת הקלפים שראית/הטלת.
- טיימר אופציונלי (3 דקות, ברירת מחדל כבוי).
- ⚠️ **אף צד לא רואה את הסיידבורדינג של השני** עד תום המאצ'.

### 13.4 ⭐ המטא־טרקר — הפיצ'ר שמשרת את רוח הפורמט

התיאור מדבר על *"endless mind games"* ועל *"לוודא שהמטא שלך לא הופך למחזור חוזר"*.
לכן **מעקב היסטורי הוא פיצ'ר ליבה, לא תוספת**:

```ts
interface SeriesLog {
  seriesId: string;
  matches: {
    matchNumber: number;
    games: { winner: PlayerId; turns: number; winCondition: string; onPlay: PlayerId }[];
    sideboardPlans: Record<PlayerId, { in: CardCount[]; out: CardCount[] }[]>;  // לכל משחק
    consideringChanges: Record<PlayerId, CardCount[]>;   // מה נכנס לסייד בין מאצ'ים
  }[];
}
```

מסך "המטא שלנו" מציג:
- **אחוזי ניצחון on-play מול on-draw** (קריטי בדק קומבו).
- **התפלגות אורך משחקים** (בכמה תורות מנצחים).
- **מה כל שחקן מסיידבורד ובאיזו תדירות** — נחשף רק אחרי סיום המאצ', וזה **בדיוק**
  משחק הראש שהפורמט מנסה לייצר.
- **התראת "מחזור חוזר"**: אם אותה תוכנית סיידבורד חזרה 3 מאצ'ים ברצף — התראה
  ("שקול לגוון מה־considering board"). זה בדיוק מה שהתיאור ביקש.
- מונה `matchesPlayedWithoutSideboard` שמנהל את המלצת "4 המאצ'ים הראשונים".

---

## 14. תוכנית בדיקות

### 14.1 הפירמידה

| שכבה | כמות | כלי | זמן ריצה |
|---|---|---|---|
| **1. יחידה לכל קלף** | ~25 קבצים, ~120 בדיקות | Vitest | < 2s |
| **2. אינטראקציות** (§15) | ~90 בדיקות | Vitest | < 5s |
| **3. חוקי בסיס** (SBA, פריוריטי, תור, מוליגן) | ~40 | Vitest | < 2s |
| **4. Redaction / דליפת מידע** | ~15 | Vitest | < 1s |
| **5. Property / fuzz** | 10k משחקים | fast-check | < 60s (nightly) |
| **6. Golden replays** | ~20 משחקים מוקלטים | Vitest snapshot | < 5s |
| **7. E2E שני דפדפנים** | ~12 תרחישים | Playwright | ~3 דק' |

### 14.2 ה־Test Harness — ה־DSL

הבדיקות חייבות להיקרא כמו תיאור מצב משחק, אחרת אף אחד לא יכתוב אותן.

```ts
// packages/engine/test/harness.ts
const t = testGame({ seed: 42, startingPlayer: 'p1' });

t.p1.hand('Show and Tell', 'Omniscience', 'Brainstorm');
t.p1.battlefield('Island', 'Island', 'Island');
t.p2.hand('Atraxa, Grand Unifier', 'Mana Drain');
t.p2.battlefield('Island', 'Island');
t.p1.library('Dig Through Time', 'Brainstorm', /* ...ראש הספרייה בסדר מדויק */);
t.setPhase('main1');

t.p1.cast('Show and Tell');
t.p2.pass();
// שניהם בוחרים בסתר:
t.p1.secretChoose('Omniscience');
expect(t.p2.view().secretChoice.opponentLockedIn).toBe(true);
expect(JSON.stringify(t.p2.view())).not.toContain('omniscience');  // ← אין דליפה
t.p2.secretChoose('Atraxa, Grand Unifier');

t.resolveAll();
expect(t.battlefieldNames('p1')).toContain('Omniscience');
expect(t.battlefieldNames('p2')).toContain('Atraxa, Grand Unifier');
expect(t.p2.handSize()).toBe(/* 1 (Mana Drain) + מה ש־Atraxa לקחה */);
```

**יכולות חובה ב־harness:**

```ts
interface TestGame {
  // הרכבת מצב
  p1: PlayerHandle; p2: PlayerHandle;
  setPhase(p: Phase, s?: Step): void;
  setLife(p: PlayerId, n: number): void;

  // פעולות
  resolveTop(): void;          // פותר את הפריט העליון בסטאק
  resolveAll(): void;          // פותר עד שהסטאק ריק
  passUntil(phase: Phase): void;

  // בדיקות
  battlefieldNames(p: PlayerId): string[];
  stackNames(): string[];
  events(): GameEvent[];
  /** בודק שהאירוע קרה בדיוק N פעמים — קריטי ל־Bowmasters */
  countEvents(type: string): number;
  /** אינווריאנטה: 60 קלפים לכל שחקן, תמיד */
  assertCardConservation(): void;
  /** האם פעולה מסוימת חוקית כרגע */
  canCast(p: PlayerId, name: string): boolean;
}
```

### 14.3 שכבה 4 — בדיקות דליפת מידע (קטגוריה נפרדת ומחייבת)

```ts
describe('redaction', () => {
  it('לעולם לא חושף את יד היריב', () => {
    const t = setupGame();
    t.p2.hand('Atraxa, Grand Unifier', 'Mana Drain', 'Omniscience');
    const view = JSON.stringify(t.p1.view());
    for (const name of ['atraxa', 'mana_drain', 'omniscience']) {
      expect(view.toLowerCase()).not.toContain(name);
    }
    expect(t.p1.view().hands.p2).toEqual({ count: 3 });
  });

  it('לעולם לא חושף סדר ספרייה — גם לא לבעליה', () => {
    expect(t.p1.view().libraries.p1).toEqual({ count: 53 });
  });

  it('Show and Tell: בחירת p1 לא מגיעה ל־p2 לפני שהוא נעל', () => { /* ... */ });

  it('Brainstorm חושף רק לשולף', () => { /* ... */ });

  it('Surveil של Hedge Maze לא חושף ליריב את הקלף שנשאר למעלה', () => { /* ... */ });

  it('Atraxa — 10 הקלפים החשופים כן פומביים לשניהם', () => { /* ← ההפך! */ });
});
```

**כלל CI:** אם `redact()` משתנה — הבדיקות האלה חייבות לרוץ. `packages/engine/src/redact.ts`
מסומן כ־`CODEOWNERS` קריטי.

### 14.4 שכבה 5 — Property / Fuzz

בוט שמשחק פעולות חוקיות אקראיות, אלפי משחקים, ומאמת **אינווריאנטות**:

```ts
const invariants = [
  // שימור קלפים — הכי חשובה, תופסת באגי מעבר זונות
  (s) => totalCards(s, 'p1') === 60 && totalCards(s, 'p2') === 60,
  // אין iid כפול בשתי זונות
  (s) => new Set(allCards(s).map(c => c.iid)).size === allCards(s).length,
  // חיים בטווח שפוי
  (s) => s.players.p1.life <= 100 && s.players.p2.life <= 100,
  // אין שני Atraxa אצל אותו שולט אחרי SBA
  (s) => !hasDuplicateLegend(s),
  // אם המשחק לא נגמר, למישהו יש פריוריטי או שיש בחירה פתוחה
  (s) => s.winner !== null || s.priorityPlayer !== null || s.pendingChoice !== null,
  // ה־mana pool ריק בתחילת כל צעד
  (s) => atStepStart(s) ? isPoolEmpty(s) : true,
  // אין לולאה אינסופית — תקרה של 2000 פעולות למשחק
];
```

**בדיקת דטרמיניזם:** אותו seed + אותו `actionLog` → אותו hash של state סופי. זה מה שמגן
על ה־replay וה־undo.

```ts
it('דטרמיניסטי', () => {
  const log = playRandomGame(seed);
  expect(hashState(replay(seed, log))).toBe(hashState(replay(seed, log)));
});
```

### 14.5 שכבה 6 — Golden Replays

מקליטים ~20 משחקים אמיתיים (או משחקי בוט מעניינים), שומרים `{seed, actionLog, finalHash}`.
כל שינוי במנוע שמשנה תוצאה של replay ישן — נכשל ב־CI עם דיף קריא. זה **רשת הביטחון
נגד רגרסיות** כשמשנים את מנוע המאנה או את מנגנון הטריגרים.

### 14.6 שכבה 7 — E2E שני דפדפנים (Playwright)

```ts
test('Show and Tell — בחירה סימולטנית ללא דליפה', async ({ browser }) => {
  const [a, b] = await Promise.all([browser.newPage(), browser.newPage()]);
  const wsFrames: string[] = [];
  b.on('websocket', ws => ws.on('framereceived', f => wsFrames.push(f.payload as string)));

  await joinSameGame(a, b);
  await castShowAndTell(a);

  await a.getByTestId('secret-pick-omniscience').click();
  await a.getByTestId('lock-in').click();

  // b רואה "נעל" אבל לא מה
  await expect(b.getByTestId('opponent-locked')).toBeVisible();
  expect(wsFrames.join()).not.toContain('omniscience');   // ← הבדיקה האמיתית

  await b.getByTestId('secret-pick-atraxa').click();
  await b.getByTestId('lock-in').click();

  await expect(a.getByTestId('bf-p2')).toContainText('Atraxa');
  await expect(b.getByTestId('bf-p1')).toContainText('Omniscience');
});
```

תרחישים נוספים ל־E2E: reconnect באמצע בחירה, undo נדחה אחרי shuffle, זרימת סיידבורד מלאה,
auto-pass עם השהיה אקראית, קומבו טורן של 15 הטלות עם TriggerPolicy.

### 14.7 קורפוס חוקים

קובץ `test/rulings.yaml` שממפה כל טענה לבדיקה, עם מקור:

```yaml
- id: mdfc-hand-is-front-face
  cr: "712.8a"
  claim: "Waterlogged Teachings ביד הוא Instant ולא Land"
  test: interactions/show-and-tell.test.ts::"אי אפשר לבחור MDFC ל־Show and Tell"

- id: hybrid-generic-mv
  cr: "202.3f"
  claim: "MV של {2/B}{2/G}{2/U} הוא 6"
  test: cards/rakshasas-bargain.test.ts::"MV הוא 6"

- id: hexproof-from-quality
  cr: "702.11d"
  claim: "hexproof from black חוסם יכולת ממקור שחור של יריב"
  test: interactions/veil-bowmasters.test.ts
```

זה הופך את "האם המימוש נכון?" לשאלה שאפשר לענות עליה בסקירת קוד.

### 14.8 CI

```
pre-commit:  typecheck + eslint + שכבות 1-4 (< 10s)
PR:          + שכבה 6 (golden) + 1000 משחקי fuzz + E2E (< 5 דק')
nightly:     10k משחקי fuzz + כל ה־E2E + בדיקת עדכון Scryfall
```

---

## 15. מטריצת האינטראקציות

**זו רשימת המשימות של `test/interactions/`.** כל שורה = בדיקה אחת לפחות.
מסומן ⭐ = קריטי, שבירה שלו שוברת את המשחק.

### 15.1 Show and Tell

| # | תרחיש | תוצאה צפויה |
|---|---|---|
| 1 ⭐ | שני השחקנים בוחרים | שניהם נכנסים **בו־זמנית** |
| 2 ⭐ | p1 נועל, p2 עדיין בוחר | p2 לא רואה את בחירת p1 בשום שדה ב־view |
| 3 | p1 בוחר "ללא" | רק של p2 נכנס |
| 4 | שניהם "ללא" | הספל נפתר, כלום לא קורה |
| 5 ⭐ | ביד יש `Waterlogged Teachings` | **לא בחירה חוקית** (MDFC ביד = instant) |
| 6 | ביד יש רק instants/sorceries | האפשרות היחידה היא "ללא" |
| 7 | Show and Tell מבוטל ע"י Mana Drain | אין בחירה בכלל |
| 8 ⭐ | שניהם שמים Atraxa | **שניהם נשארים** — חוק האגדות לא חל (שולטים שונים) |
| 9 ⭐ | שניהם שמים Atraxa | שני טריגרי ETB, סדר APNAP, ה־AP בוחר ראשון |
| 10 | p1 שם Hedge Maze | surveil מטרגר אחרי שגם הקלף של p2 נכנס |
| 11 ⭐ | p1 שם Omniscience, p2 שם Atraxa | p1 מקבל פריוריטי ראשון (הוא ה־AP) → יכול "לרוץ" |
| 12 | p1 שם Mystic Sanctuary עם 3 Islands | נכנס לא מוטה, הטריגר עולה |
| 13 | Show and Tell עם `Borne Upon a Wind` ב־end step של היריב | חוקי |
| 14 | Show and Tell תחת Omniscience בפייז לא־ראשי | **לא חוקי** (sorcery timing) |
| 15 | ניסיון undo אחרי lockIn | נדחה |

### 15.2 Omniscience

| # | תרחיש | תוצאה |
|---|---|---|
| 16 ⭐ | הטלת `Dig Through Time` בחינם | עולה 0; **הפרומפט של delve מדולג**; 0 קלפים מוגלים |
| 17 | הטלת `Rakshasa's Bargain` בחינם | עולה 0 למרות ההיברידים |
| 18 ⭐ | ניסיון "להטיל" קרקע | **לא חוקי** — קרקעות אינן ספלים |
| 19 ⭐ | `Show and Tell` תחת Omniscience ב־upkeep | **לא חוקי** |
| 20 ⭐ | + `Borne Upon a Wind` | Show and Tell נהיה חוקי בכל רגע |
| 21 ⭐ | Hullbreaker Horror מחזיר את Omniscience ליד באמצע רצף | ההיתר **נעלם מיד**; הספל הבא דורש מאנה |
| 22 | הטלת Mana Drain בחינם | הביטול עובד; המאנה עדיין מתווספת בפייז הראשי הבא |
| 23 | Omniscience אצל **שני** השחקנים | שניהם מטילים בחינם; ה־AP מקבל פריוריטי ראשון |
| 24 | הטלה בחינם + hold priority | אפשר לשרשר בלי לתת פריוריטי |

### 15.3 Mana Drain

| # | תרחיש | תוצאה |
|---|---|---|
| 25 ⭐ | Drain על `Rakshasa's Bargain` | **6 מאנה חסרת־צבע** בפייז הראשי הבא (MV=6!) |
| 26 | Drain על `Show and Tell` | 3 מאנה |
| 27 | Drain על `Atraxa` | 7 מאנה |
| 28 | Drain על `Waterlogged Teachings` (פן קדמי) | 4 מאנה |
| 29 ⭐ | Drain מול `Veil of Summer` | הביטול נכשל — אבל **המאנה כן מגיעה** (ראו הערה למטה) |
| 30 ⭐ | Drain מול `Mistrise Village` | הביטול נכשל; **המאנה כן מגיעה** |
| 31 ⭐ | Drain על `Hullbreaker Horror` | חוקי למקד; הביטול לא עובד; **המאנה כן מגיעה** |
| 31b ⭐ | המטרה כבר לא על הסטאק | Mana Drain **פוקע** — ואז **אין מאנה** |
| 32 | Drain על Drain | הפנימי מתבטל; מאנה = 2 |
| 33 ⭐ | מאנה לא נוצלה בפייז הראשי | **נשפכת** בסוף הפייז; אין mana burn |
| 34 | Drain בתור של היריב | המאנה מגיעה בפייז הראשי הבא **שלך** |
| 34b | Drain בפייז הראשי המוקדם שלך | המאנה מגיעה ב**פייז הראשי המאוחר של אותו תור** |
| 35 | Drain + מאנה → Omniscience באותו פייז | הקומבו עובד |

### 15.4 Orcish Bowmasters

| # | תרחיש | תוצאה |
|---|---|---|
| 36 ⭐ | היריב מטיל `Brainstorm` | **3 טריגרים** נפרדים |
| 37 ⭐ | השליפה הרגילה של היריב ב־draw step | **0 טריגרים** |
| 38 ⭐ | היריב מטיל `Dig Through Time` | **0 טריגרים** ("put into hand" ≠ draw) |
| 39 ⭐ | היריב מטיל `Rakshasa's Bargain` | **0 טריגרים** |
| 40 ⭐ | היריב מטיל `Planar Genesis` | **0 טריגרים** |
| 41 ⭐ | `Atraxa` של היריב לוקחת 4 קלפים | **0 טריגרים** |
| 42 | היריב מטיל `Borne Upon a Wind` | **1 טריגר** (draw a card) |
| 43 | `Veil of Summer` של היריב שולף | **1 טריגר** |
| 44 | ETB של ה־Bowmasters עצמו | 1 טריגר |
| 45 ⭐ | **שני** Bowmasters + Brainstorm של היריב | **6 טריגרים**; טוקן אחד + 5 מונים → Army 5/5 |
| 46 | Amass ראשון | נוצר טוקן `Orc Army` 0/0 שחור, ואז מון → 1/1 |
| 47 | Army בלי מונים (תיאורטי) | מת ב־SBA |
| 48 ⭐ | היריב עם `Veil of Summer` | היריב וקבועיו **יורדים מרשימת המטרות**; אתה עדיין מטרה חוקית לעצמך, ולכן הטריגר נפתר וה־Amass **כן** קורה |
| 48b | טריגר Bowmasters בלי שום מטרה חוקית בכלל | מוסר מהסטאק — **וגם ה־Amass לא קורה** |
| 49 | מיקוד ב־Atraxa (7/7) | 1 נזק, לא מת |
| 50 | Bowmasters מת בתגובה לטריגר | הטריגר עדיין נפתר (LKI) |
| 51 | Brainstorm כשהיריב ב־2 חיים | 3 טריגרים → יכול להרוג |

### 15.5 Veil of Summer

| # | תרחיש | תוצאה |
|---|---|---|
| 52 ⭐ | היריב הטיל ספל כחול השנה | שולף קלף |
| 53 | היריב לא הטיל כחול/שחור | **לא** שולף |
| 54 ⭐ | ספל שהוטל **אחרי** ה־Veil | גם הוא לא ניתן לביטול |
| 55 ⭐ | קבוע שנכנס **אחרי** ה־Veil | **לא** מקבל hexproof (הרשימה ננעלה) |
| 56 ⭐ | `Orcish Bowmasters` של היריב ממקד אותך | **לא חוקי** (מקור שחור) |
| 57 ⭐ | `Hullbreaker Horror` של היריב מנסה להחזיר את ה־Atraxa שלך | **לא חוקי** (מקור כחול) |
| 58 ⭐ | `Hullbreaker Horror` של היריב מחזיר **ספל** שלך מהסטאק | **חוקי!** ספל אינו "קבוע שאתה שולט" — ה־Veil לא מגן |
| 59 | Veil מול Veil | שניהם עובדים |
| 60 | Veil אחרי ש־Mana Drain כבר נפתר | מאוחר מדי |

### 15.6 Hullbreaker Horror

| # | תרחיש | תוצאה |
|---|---|---|
| 61 | הטלת ה־Horror עצמו | **לא** מטרגר את עצמו |
| 62 ⭐ | "עד אחד" — בחירת אפס | חוקי, כלום לא קורה |
| 63 ⭐ | החזרת ספל של היריב מהסטאק | הספל לא נפתר (≠ counter) |
| 64 ⭐ | היריב עם `Veil of Summer`, החזרת **ספל** | חוקי |
| 65 ⭐ | היריב עם `Veil of Summer`, החזרת **קבוע** | לא חוקי |
| 66 | `Mana Drain` על ה־Horror | הביטול נכשל (can't be countered) |
| 67 ⭐ | Horror + Omniscience, 10 הטלות | **10 טריגרים**; TriggerPolicy מטפל |
| 68 ⭐ | Horror מול Horror | מלחמת החזרות; כל טריגר מטרגר את השני |
| 69 | Horror מחזיר Omniscience של היריב | היריב מאבד את ההיתר מיד |
| 70 | Horror מגיע דרך Show and Tell | הטריגר פעיל מהספל הבא |

### 15.7 Atraxa

| # | תרחיש | תוצאה |
|---|---|---|
| 71 ⭐ | ETB עם ספרייה מלאה | חושף 10 **בפומבי**; עד 8 סוגי קלף |
| 72 ⭐ | בין החשופים `Waterlogged Teachings` | נספר כ־**instant** בלבד, לא land |
| 73 | קלף עם שני סוגים (אין בדק, אבל קוד נכון) | ניתן לבחור פעם אחת בלבד |
| 74 | "you may" | מותר לא לקחת כלום |
| 75 | ספרייה עם 6 קלפים | חושף 6 |
| 76 | ספרייה ריקה | הטריגר נפתר, כלום |
| 77 ⭐ | תחתית בסדר **אקראי** | אותו seed → אותו סדר (דטרמיניזם) |
| 78 ⭐ | שני Atraxa אצל **שולטים שונים** | שתיהן נשארות |
| 79 ⭐ | שני Atraxa אצל **אותו שולט** | חוק האגדות → אחת לבית קברות |
| 80 | Atraxa חוסמת Atraxa | deathtouch → שתיהן מתות |
| 81 | Atraxa תוקפת, lifelink | +7 חיים |
| 82 | Atraxa מוחזרת ליד ע"י Horror ומושמת שוב | ETB חדש |

### 15.8 קלפי ספרייה ומאנה

| # | תרחיש | תוצאה |
|---|---|---|
| 83 ⭐ | `Brainstorm` + fetch באותו תור | 2 הקלפים הרעים מתערבבים פנימה |
| 84 ⭐ | `Brainstorm` עם 2 קלפים בספרייה | שליפה מריקה → הפסד ב־SBA הבא |
| 85 | `Brainstorm` — סדר ההחזרה | `chosen[0]` הוא העליון |
| 86 ⭐ | `Assemble the Team` — ספרייה 53 | חיפוש ב־18 העליונים בדיוק |
| 87 | `Assemble the Team` — ספרייה 1 | חיפוש ב־1 |
| 88 | `Assemble the Team` — לא נמצא | חוקי; **עדיין מערבב** |
| 89 ⭐ | `Dig Through Time` — delve 6 קלפים | עולה {U}{U} בלבד |
| 90 | `Dig Through Time` — בית קברות ריק | חייב לשלם {6}{U}{U} מלא |
| 91 ⭐ | delve מגלה קלפים ש־`Mystic Sanctuary` רצה | הם כבר לא בבית הקברות |
| 92 ⭐ | `Rakshasa's Bargain` → 2 לבית קברות | מזין delve באותו תור |
| 93 | `Rakshasa's Bargain` — תשלום {2} מול {B} | שתי הדרכים חוקיות |
| 94 ⭐ | `Mystic Sanctuary` עם 3 Islands אחרים | נכנס לא מוטה, הטריגר עולה |
| 95 ⭐ | סופרים **subtype** Island | Breeding Pool/Watery Grave/Hedge Maze נספרים! |
| 96 | `Mystic Sanctuary` עם 2 Islands | נכנס מוטה, **אין** טריגר |
| 97 | `Mystic Sanctuary` + בית קברות ריק | הטריגר מוסר (אין מטרה) |
| 98 ⭐ | fetch מביא `Mystic Sanctuary` | הספירה נעשית ברגע הכניסה |
| 99 ⭐ | `Mistrise Village` עם `Breeding Pool` בשדה | נכנס **לא מוטה** (Forest!) |
| 100 | `Mistrise Village` בלי Forest | נכנס מוטה |
| 101 ⭐ | יכולת Mistrise, ואז 2 ספלים | רק ה**ראשון** לא ניתן לביטול |
| 102 | יכולת Mistrise ולא מטילים כלום | האפקט פג בסוף התור |
| 103 ⭐ | `Planar Genesis` ב־end step של היריב שם קרקע | **לא צורך land drop** |
| 104 | `Planar Genesis` בלי קרקע בין ה־4 | קלף ליד במקום |
| 105 ⭐ | `Borne Upon a Wind` + ניסיון לשחק קרקע ב־instant speed | **לא חוקי** — קרקע אינה ספל |
| 106 | fetch ב־1 חיים | מותר לשלם → 0 חיים → הפסד |
| 107 | shock ב־2 חיים | מותר לשלם → 0 → הפסד |
| 108 ⭐ | `Waterlogged Teachings` מחפש `Hullbreaker Horror` | **חוקי** — יש לו flash |
| 109 ⭐ | `Waterlogged Teachings` מחפש `Orcish Bowmasters` | **חוקי** — flash |
| 110 | `Waterlogged Teachings` מחפש `Show and Tell` | **לא חוקי** (sorcery, בלי flash) |
| 111 | שחקן משחק את הגב `Inundated Archive` | צורך land drop; נכנס מוטה |
| 112 ⭐ | `Assemble the Team` דורש {B}{G} עם 3 מקורות | ה־solver מוצא; greedy נכשל |

### 15.9 חוקי בסיס

| # | תרחיש |
|---|---|
| 113 | מוליגן London — 7→6, בחירת 1 לתחתית |
| 114 | מוליגן ל־0 |
| 115 | סדר טריגרים APNAP עם 4 טריגרים בו־זמנית |
| 116 | ספל שמאבד את כל מטרותיו — פוקע |
| 117 | ה־mana pool מתרוקן בין צעדים |
| 118 | summoning sickness (Atraxa דרך Show and Tell לא יכולה לתקוף מיד) |
| 119 | vigilance — Atraxa לא מוטה בהתקפה |
| 120 | הפסד בשליפה מספרייה ריקה בתחילת התור |

---

## 16. תוכנית בנייה בשלבים

כל שלב מסתיים ב־**קריטריון קבלה מדיד**. אין מעבר לשלב הבא בלי שהבדיקות ירוקות.

### שלב 0 — תשתית (2–3 ימים)
- pnpm workspaces, TS strict, Vitest, ESLint, CI.
- `data/oracle-cards.json` (✅ כבר קיים), `data/decklist.json`, `data/format.json`.
- סקריפט `pnpm sync:cards` שמושך מחדש מ־Scryfall ו**נכשל אם טקסט אורקל השתנה** —
  התראה על עדכוני oracle.
- **קבלה:** `pnpm test` רץ, `loadOracle()` מחזיר 25 קלפים מטויפסים.

### שלב 1 — ליבת המנוע, בלי קלפים (5–7 ימים)
זונות, `CardInstance`, PRNG מזורע, מבנה התור, פריוריטי, סטאק, SBA, mana pool, `redact()`.
"קלפי דמה": קרקע ורנילה, יצור ונילה, ספל ונילה.
- **קבלה:** בדיקות: משחקים 5 תורות, מניחים קרקע, מטילים יצור ונילה, תוקפים, גורמים נזק,
  שחקן מגיע ל־0 ומפסיד. `assertCardConservation()` עובר. שכבה 4 (redaction) ירוקה.

### שלב 2 — הקרקעות (2–3 ימים)
כל 10 סוגי הקרקעות + MDFC + fetch + shock + surveil + תנאי כניסה.
- **קבלה:** בדיקות 94–111 ירוקות. טבלת ה־fetch של §10.2 מאומתת במלואה.

### שלב 3 — מנוע המאנה המלא (3 ימים)
פרסור עלויות, היברידים, `solvePayment` עם backtracking, delve, עלות חלופית.
- **קבלה:** בדיקה 112 (Assemble the Team {B}{G}) ירוקה. Property test:
  1000 מצבי קרקע אקראיים — ה־solver לעולם לא מחזיר `null` כשקיים פתרון (מאומת מול brute force).

### שלב 4 — הקלפים הפשוטים (3 ימים)
Brainstorm, Demonic Tutor, Assemble the Team, Dig Through Time, Rakshasa's Bargain,
Planar Genesis, Borne Upon a Wind, Waterlogged Teachings.
- **קבלה:** שכבה 1 (יחידה) ירוקה לכל 8. בדיקות 83–93, 103–110.

### שלב 5 — ⭐ Show and Tell + Omniscience (4 ימים)
`simultaneousSecretChoice`, `moveSimultaneously`, `castPermission`, Atraxa, Hullbreaker Horror.
- **קבלה:** §15.1 (1–15), §15.2 (16–24), §15.7 (71–82) — **כולן** ירוקות.
  כולל בדיקת "אין דליפה ב־view של p2".

### שלב 6 — האינטראקטיביים (3 ימים)
Mana Drain, Orcish Bowmasters, Veil of Summer, Mistrise Village, Mystic Sanctuary.
- **קבלה:** §15.3–15.6 (25–70) ירוקות. **המנוע שלם** — 120 בדיקות אינטראקציה עוברות.

### שלב 7 — שרת + פרוטוקול (4 ימים)
WebSocket, lobby, match runner, `actionLog` ב־SQLite, reconnect, undo.
- **קבלה:** שני לקוחות `wscat` יכולים לשחק משחק שלם. ניתוק ב־turn 5 → reconnect →
  אותו מצב בדיוק. `undo` נדחה אחרי shuffle.

### שלב 8 — לקוח MVP (7 ימים)
פריסת §12.2, גרירה, סטאק, בחירות, קרב. **מכוער אבל מלא.**
- **קבלה:** E2E: שני דפדפנים משחקים משחק שלם כולל Show and Tell.

### שלב 9 — ⭐ שכבת הנוחות (7 ימים) — **אל תדלגו על זה**
auto-pass + השהיה אקראית, hold priority, `TriggerPolicy`, מצב Omniscience,
"ראש הספרייה הידוע", מסך ה־Show and Tell עם החשיפה הדרמטית, קיצורי מקלדת, אנימציות,
בידול המירור, אזהרת מאנה צפה, undo ב־UI.
- **קבלה:** "טורן קומבו" מלא (Show and Tell → Omniscience → 12 הטלות → Atraxa)
  מתבצע ב־**פחות מ־20 לחיצות ובלי אף פרומפט מיותר**. זו מדידה, לא תחושה.

### שלב 10 — Bo3 + סיידבורד + Considering (4 ימים)
מכונת המצבים של §13.2, מסך סיידבורד, `SeriesLog`, המטא־טרקר.
- **קבלה:** סדרת 3 מאצ'ים מלאה עם החלפת considering board בין מאצ'ים; המטא־טרקר
  מציג סטטיסטיקות נכונות; התראת "מחזור חוזר" עובדת.

### שלב 11 — Replay, Lab Mode, ליטוש (5 ימים)
נגן replay, "פצל מכאן", מצב goldfish לאימון סולו, בוט בסיסי, הגדרות, פרסום.
- **קבלה:** replay של משחק ישן מפיק hash זהה. Lab mode מאפשר לשחק קו חלופי.

**סה"כ אומדן: ~7–9 שבועות למפתח יחיד.** הנתיב הקריטי הוא שלבים 5–6 (נכונות) ו־9 (נוחות).

---

## 17. סיכונים ומלכודות

| # | סיכון | חומרה | מיטיגציה |
|---|---|---|---|
| 1 | **דליפת מידע ב־Show and Tell** | 🔴 שובר משחק | `redact()` שבונה מאפס + שכבת בדיקות 4 + בדיקת WS ב־E2E |
| 2 | **`drawN(3)` במקום 3 draws** ב־Brainstorm | 🔴 שובר את Bowmasters בשקט | בדיקה 36 סופרת `countEvents('draw')` |
| 3 | **MDFC ביד נחשב land** | 🟠 מאפשר Show and Tell לא־חוקי | בדיקה 5 + 72, קורפוס CR |
| 4 | **MV היברידי מחושב כ־3** | 🟠 Mana Drain נותן 3 במקום 6 | בדיקה 25 |
| 5 | **`Mystic Sanctuary` סופר לפי שם ולא subtype** | 🟠 | בדיקה 95 |
| 6 | **פרומפטים אינסופיים ב־combo turn** | 🟠 הורג חוויה | `TriggerPolicy` + קריטריון קבלה מדיד בשלב 9 |
| 7 | **דליפת מידע דרך תזמון auto-pass** | 🟡 | השהיה אקראית קבועה 150–400ms |
| 8 | **greedy auto-tap נתקע על `Assemble the Team`** | 🟡 | solver + property test מול brute force |
| 9 | **`Veil of Summer` נועל hexproof לא נכון** | 🟡 | בדיקה 55 (קבוע חדש לא מוגן) |
| 9b | **הנחה ש־Veil מבטל את כל האפקט של המבטל** | 🟠 | בדיקה 29 — המאנה של Drain כן מגיעה |
| 9c | **הוצאת ספל מהסטאק לפני שהוא סיים להיפתר** | 🔴 קלף "נעלם" מכל הזונות | CR 608.2m; נתפס ע"י בדיקת שימור הקלפים ב־fuzz |
| 10 | **לולאה אינסופית** (Horror מול Horror) | 🟡 | תקרת פעולות + זיהוי loop + הצעת draw |
| 11 | **עדכון Oracle של WotC משנה קלף** | 🟡 | `pnpm sync:cards` נכשל על שינוי טקסט |
| 12 | **undo מאפשר רמאות** | 🟠 | 3 תנאי ה־safe window (§11.3), נאכפים בשרת |

### 17.5 רישוי ותוכן

- **תמונות וטקסטים של קלפים** שייכים ל־Wizards of the Coast. הפרויקט צריך לפעול תחת
  ה־**Fan Content Policy**: ללא מונטיזציה, עם כתב ויתור ברור, ולא להציג את עצמו כמוצר רשמי.
- **Scryfall API**: יש לכבד את מדיניות הקצב (≤10 בקשות/שנייה, User-Agent מזהה) ולשמור
  את הנתונים מקומית במקום לקרוא בזמן ריצה. הקובץ `data/oracle-cards.json` עושה בדיוק את זה.
- שקלו להריץ את זה כפרויקט פרטי בין שני שחקנים — מה שהפורמט ממילא מיועד לו.

---

## 18. נספחים

### 18.1 פירוק הדק

```
קרקעות (18):
  4 Flooded Strand      4 Polluted Delta       2 Breeding Pool
  2 Watery Grave        1 Hallowed Fountain    1 Hedge Maze
  1 Undercity Sewers    1 Mystic Sanctuary     1 Mistrise Village
  1 Island
  (+ 2 Waterlogged Teachings כקרקע מהגב = 20 מקורות אפקטיביים)

ספלים (42):
  קומבו:      4 Show and Tell   4 Omniscience   4 Atraxa
  חיפוש:      4 Assemble the Team   4 Dig Through Time   3 Rakshasa's Bargain
              2 Waterlogged Teachings   1 Demonic Tutor
  קנטריפ:     4 Brainstorm      1 Borne Upon a Wind
  אינטראקציה: 4 Mana Drain      2 Orcish Bowmasters   2 Veil of Summer
  מאנה/גמיש:  2 Planar Genesis
  איום נוסף:  1 Hullbreaker Horror
```

### 18.2 סוגי הקלפים בדק (רלוונטי ל־Atraxa)

Atraxa יכולה לקחת קלף אחד מכל סוג. בדק הזה קיימים בפועל רק **3 סוגים**:

| סוג | קלפים בדק | מקסימום מ־Atraxa |
|---|---|---|
| Creature | Atraxa, Hullbreaker Horror, Orcish Bowmasters | 1 |
| Enchantment | Omniscience | 1 |
| Instant | Brainstorm, Mana Drain, Dig Through Time, Veil of Summer, Borne Upon a Wind, Planar Genesis, Rakshasa's Bargain, Waterlogged Teachings | 1 |
| Sorcery | Show and Tell, Demonic Tutor, Assemble the Team | 1 |
| Land | 18 קרקעות | 1 |
| Artifact / Planeswalker / Battle | — | 0 |

👉 **Atraxa לוקחת מקסימום 5 קלפים** בדק הזה. ה־UI צריך להציג את זה כ־5 "משבצות סוג"
ולא כרשימה חופשית — הרבה יותר קל להבנה.

### 18.3 הפניות לחוקים (CR) שהמימוש נשען עליהן

| CR | נושא | קלף |
|---|---|---|
| 101.4 | בחירות בו־זמניות, APNAP | Show and Tell |
| 202.3f | MV של סמל היברידי־גנרי | Rakshasa's Bargain |
| 500.4 | ריקון mana pool בסוף כל צעד/פייז | Mana Drain |
| 601.2 | תהליך הטלת ספל | הכל |
| 601.2b | עלויות חלופיות | Omniscience |
| 608.2b | ספל בלי מטרות חוקיות פוקע | Mystic Sanctuary, Bowmasters |
| 613 | שכבות | Veil of Summer (6), Amass (7d) |
| 614 | אפקטי החלפה | shocklands |
| 701.44 | Amass | Orcish Bowmasters |
| 702.11d | Hexproof from [quality] | Veil of Summer |
| 702.66 | Delve | Dig Through Time |
| 704.5b | הפסד בשליפה מספרייה ריקה | Brainstorm |
| 704.5j | חוק האגדות | Atraxa |
| 712.8a | DFC בזונה שאינה שדה/סטאק = פן קדמי | Waterlogged Teachings |

### 18.4 מקורות

- נתוני הקלפים: [Scryfall API](https://scryfall.com) — נשמרו ב־`data/oracle-cards.json`
- חוקי הפורמט: [Timeless — MTG Wiki](https://mtg.wiki/page/Timeless),
  [Timeless Banlist (Aetherhub)](https://aetherhub.com/Banlist/Timeless/),
  [Banned & Restricted Announcements (WotC)](https://magic.wizards.com/en/news/announcements/banned-and-restricted-june-29-2026)
- Comprehensive Rules: [WotC Rules](https://magic.wizards.com/en/rules)

---

## סיכום ההמלצות בשורה אחת כל אחת

1. **שרת סמכותי + redaction** — לא אופציונלי, זו דרישת נכונות.
2. **Seeded RNG + event sourcing** — נותן replay, undo, ובדיקות דטרמיניסטיות בחינם.
3. **Generators לסקריפטי קלפים** — הקוד ייראה כמו הטקסט של הקלף.
4. **`simultaneousSecretChoice` הוא הפרימיטיב שמגדיר את הפורמט** — בנו אותו נכון קודם.
5. **`hasAnyLegalAction()` בליבת המנוע** — הבסיס ל־auto-pass, שהוא פיצ'ר הנוחות הגדול.
6. **`TriggerPolicy`** — בלעדיו הקומבו עם Hullbreaker Horror בלתי־שחיק.
7. **מעקב "ראש הספרייה הידוע"** — הפיצ'ר שיגרום לשחקנים להעדיף את זה על פני MTGO.
8. **מטא־טרקר לסדרות** — משרת ישירות את "endless mind games" שהפורמט בנוי סביבו.
9. **120 בדיקות האינטראקציה של §15 הן המפרט האמיתי** — אם הן ירוקות, המנוע נכון.
10. **שלב 9 (נוחות) אינו "ליטוש"** — הוא חצי מהמוצר.
