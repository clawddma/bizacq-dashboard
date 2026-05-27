---
name: legal-immigration
description: US M&A + immigration knowledge for foreign buyers acquiring US small businesses. Covers SBA eligibility, E-2 / EB-5 visa mechanics, industry-specific foreign-ownership restrictions, US LLC/Corp formation for non-citizens, and alternative financing when SBA is blocked.
---

# Legal-immigration skill

## SBA loan eligibility (the #1 issue for foreign buyers)

**SBA 7(a) and 504 require the borrower to be a US citizen OR Lawful Permanent Resident (LPR / green card holder).**

- Source: SBA SOP 50 10 6, Subpart B, Ch. 2
- Holders of these are **NOT eligible** as primary borrowers:
  - E-1, E-2, H-1B, L-1, O-1, TN, B-1, F-1, M-1
  - ITIN-only individuals (no SSN)
  - Asylum seekers (until granted)
- **Workaround**: a US citizen / LPR co-borrower can hold 51%+ ownership. Foreign minority owner (≤49%) is OK. This often defeats the purpose.

**Implication for non-citizen buyers**: Any deal's `suggested_structure` that proposes SBA loan >0% is **theoretical** for non-LPR buyers. Mark it explicitly: "Structure assumes SBA; buyer does not qualify without LPR. Replace with conventional + seller financing."

## E-2 Treaty Investor visa (the most common path for foreign business buyers)

**Who qualifies**: nationals of countries with a Treaty of Commerce and Navigation with the US.

- **Treaty countries** (selected list, alphabetical): Argentina, Australia, Austria, Belgium, Canada, Chile, Colombia ❌ NOT IN TREATY, Costa Rica, Czechia, Denmark, Egypt, Ethiopia, Finland, France, Germany, Honduras, Iran (frozen), Ireland, Israel, Italy, Jamaica, Japan, Jordan, Kazakhstan, South Korea, Latvia, Liberia, Lithuania, Luxembourg, Mexico ✓, Moldova, Mongolia, Morocco, Netherlands, Norway, Oman, Pakistan, Panama, Paraguay, Philippines, Poland, Portugal, Romania, Senegal, Singapore, Slovak Republic, Slovenia, Spain ✓, Sri Lanka, Sweden, Switzerland, Thailand, Togo, Trinidad and Tobago, Tunisia, Turkey, Ukraine, United Kingdom.
- **Notably NOT in E-2 treaty**: Brazil, China, India, Russia, Colombia, Venezuela, Bolivia, Cuba, Peru.
- Source: 9 FAM 402.9 (current as of early 2026). Verify against state.gov.

**Mechanics**:
- Substantial investment in a real, operating US business. No statutory minimum — practical floor ~$100K-$150K. Service businesses can be lower; capital-intensive higher.
- Investment must be "at risk" (already committed to the deal, not just promised).
- Business cannot be "marginal" — must produce more than minimal living for investor's family OR have capacity to generate jobs.
- E-2 national must hold **at least 50%** ownership.
- Investor must come to US to **direct and develop** the enterprise (not passive).
- **Validity**: typically 2-5 years, renewable indefinitely as long as enterprise operates.
- Spouse: gets E-2 derivative, **can work** (any employer).
- Children under 21: E-2 derivative, can study, **cannot work**.
- Does NOT lead to green card. Holds indefinitely renewable as long as business operates.

**E-2 + Business Acquisition workflow**:
1. Identify target business and price.
2. Form US legal entity (LLC or Corp).
3. Move funds into escrow (substantial portion of purchase price).
4. Execute Asset Purchase Agreement contingent on visa issuance.
5. File E-2 application at consulate (typically home country) or via change-of-status in US.
6. Approval timeline: 4-12 weeks consulate; up to 6 months change-of-status.
7. After approval, close deal.

**E-2 Treaty Investor cost** (typical 2026):
- Attorney legal fees: $4,000-$8,000 per visa
- DS-160 + consular fees: $315
- Visa issuance reciprocity fee (varies by country, Spain ~$0, Mexico ~$0)
- Premium processing N/A for E-2 at consulate

## EB-5 Investor Green Card

**Direct path to green card via investment.**

- Investment minimum: **$1,050,000** (general), or **$800,000** if in Targeted Employment Area (rural or high-unemployment).
- Must create **10 full-time US jobs** for US workers (direct or indirect via regional center).
- Two paths:
  - **Direct EB-5**: invest in own business, must directly employ 10. Best for businesses you operate.
  - **Regional Center EB-5**: invest in pooled fund, indirect job creation counts. Passive, but slower and you don't operate.
- Timeline: 2-4 years from filing to conditional green card. Removal of conditions after 2 years.
- After green card: **SBA loans unlock**, plus full US business participation.

**EB-5 cost** (typical 2026):
- Legal fees: $50K-$80K (immigration attorney + securities attorney for regional center)
- USCIS I-526 filing fee: $11,160
- USCIS I-829 filing fee: $9,525
- Regional center admin fees: $40K-$80K typical

## Industry restrictions on foreign ownership

**Federal restrictions** (apply nationwide):
- **Defense / classified information**: 5 USC §301, ITAR. Defense contractors typically must be US-owned. Foreign ownership triggers FOCI mitigation (very expensive).
- **Broadcasting / FCC licenses**: 47 USC §310(b). Foreign ownership capped at 25% (waivers possible).
- **Banking**: federal banking authority approval required for foreign acquirers.
- **Aviation**: 49 USC §41102. US citizens must hold at least 75% of voting interest. Cannot acquire US air carrier without restructuring.
- **Maritime / Jones Act vessels**: similar 75% US-ownership rule.
- **Critical infrastructure (CFIUS)**: any acquisition by foreign person that gives control over US critical tech, infrastructure, or sensitive personal data triggers CFIUS review. Penalties for non-filing severe.
- **Federal lobbying**: foreign principals must register under FARA.

**State-level restrictions** (vary):
- **Agricultural land**: 24 states restrict foreign ownership of farmland (TX recent legislation 2024, FL Bill 264 of 2023, others). Check state specifically.
- **Alcohol distribution**: many states restrict alcohol distributorships to citizens/residents.
- **Cannabis**: most legalized states bar foreign ownership.
- **Professional licenses**: medicine, law, accounting, engineering — some states restrict to US persons or require US license (which has its own residency rules).

**Industries with NO meaningful restriction** (foreign buyers welcome):
- Most retail, hospitality, food service, technology, e-commerce, professional services (B2B), most home services, automotive, real estate (residential and commercial property — but state ag-land rules apply).

## Recommended buying structures for foreign non-LPR buyers

**Single foreign buyer (E-2 path)**:
- Delaware LLC (favorable tax + privacy + flexibility) owned 100% by individual
- OR Wyoming LLC if extreme privacy is needed
- File E-2 at consulate, attorney $5K
- Best for small deals ($200K-$1M)

**Two foreign buyers (both E-2)**:
- Delaware LLC owned 50/50
- Both apply for E-2 simultaneously
- Operating Agreement spells out roles and exit
- Best for medium deals where both want to work

**Mix of foreign + US partner (US partner has SBA access)**:
- US partner holds 51%+ → SBA accessible
- Foreign partners hold rest, work via E-2 or E-2-derivative
- Common structure when finding US-citizen co-founder

**Pure passive foreign ownership (no operation from US)**:
- Foreign entity (e.g., Spanish SL or Mexican SA) owns US LLC
- US LLC hires US management
- Foreign owner stays abroad, visits on B-1 visa
- Works for pure cash-flow plays where you don't operate
- Tax implications: review FIRPTA, branch profits tax

## Alternative financing when SBA blocked

Pricing as of 2026:
- **Conventional bank loan (asset-backed)**: 25-35% down, Prime + 2-4%, 5-10yr amortization. Banks vary on foreign borrower comfort — community banks more flexible.
- **Seller financing**: increasingly common. Sellers typically take 20-40% on 5-7yr note at 6-8%. Critical lever for foreign buyers.
- **Private credit / mezzanine**: 30-50% down equivalent, 10-15% rates, fast close. Funds like Pursuit Lending, Live Oak (some non-SBA products), Aldrich Capital.
- **Asset-based lending (ABL)**: revolves against A/R + inventory. Works for businesses with consistent receivables.
- **Search funds / SPV with US co-investor**: structure with US-citizen GP, foreign LPs. GP takes SBA, you're LP.
- **EB-5 capital pools**: if pursuing EB-5 anyway, can use that capital.

## Cost stack (typical foreign-buyer deal close)

For a $500K asset purchase with E-2:
- Business broker: 0 (paid by seller usually)
- Buyer attorney M&A: $8K-$15K
- Buyer attorney immigration: $4K-$8K × N partners
- Tax/accounting due diligence: $3K-$6K
- LLC formation Delaware: $500 setup + $300/yr ongoing
- Title insurance (if real estate): 0.5% of property value
- USCIS fees: $315 per E-2
- **Total transaction legal/admin**: $20K-$35K plus deal capital

## Plain-language translations for the dashboard

| Internal term | Dashboard says |
|---|---|
| `feasibility=OK` | "Adquisición viable con la estructura recomendada" |
| `feasibility=WARNING` | "Adquisición posible con cambios al deal o estructura" |
| `feasibility=BLOCKED` | "No es viable con el perfil del comprador actual" |
| `sba_accessible=false` | "El comprador no califica para crédito SBA — sin SBA en la estructura" |
| `e2_compatible=true` | "Permite operar el negocio desde US con visa E-2" |
| `industry_restrictions=null` | "Sin restricciones de nacionalidad en esta industria" |
| `EB-5 path` | "Camino a green card vía inversión $800K-$1M" |
| `LPR` | "Residente permanente legal (green card)" |
| `ITIN` | "Número de identificación de contribuyente (no SSN)" |

## Critical do-not patterns

- Do not claim someone "can probably get SBA via structuring" if they don't have LPR. They can't. Period.
- Do not assume Colombian passport gives E-2 — Colombia is not in the E-2 treaty list.
- Do not skip industry check — even one defense-related deal misclassified as "OK" damages trust.
- Do not give a single recommended structure when buyer profile has 2+ partners with different nationalities — both need separate analysis.

## Verification before committing legal_check

Self-check checklist:
- [ ] Buyer's actual citizenship/LPR status reflected (not assumed)
- [ ] E-2 treaty list checked for buyer's nationality
- [ ] Industry restriction list checked (not "boilerplate none")
- [ ] If SBA proposed in deal structure, marked as inviable when applicable
- [ ] Specific dollar costs and timelines given (not "consult attorney")
- [ ] `feasibility` field reflects worst-case (don't average warnings into OK)
