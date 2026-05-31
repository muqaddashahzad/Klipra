"""Shared formatting rules injected into every LLM prompt that produces
user-facing text — clip titles, descriptions, viral hook overlays,
YouTube titles, SaaShort scripts, and transcript rewrites.

WHY THIS EXISTS
---------------
Without a single source of truth, each prompt template was making
slightly different demands of the model. That's how we ended up with
a viral hook that read "Pandrah Dollar + Sau Dollar FREE Cash!" instead
of "$15 + $100 FREE Cash!" — the transcript-cleanup prompt had been
updated to require digit format, but the clip-pick prompt that produces
the hook hadn't been. Centralising the rules guarantees they stay in
sync forever after.

HOW TO USE
----------
    from prompt_rules import USER_TEXT_RULES
    prompt = f'''
    You are a YouTube title expert.

    {USER_TEXT_RULES}

    Generate 10 titles for this video.
    '''

The rules are language-agnostic — they apply equally to English, Urdu,
Hindi, Spanish, etc. They cover the cases that have actually broken in
production, not a generic style guide.
"""

# Numbers must be digits, not words. Applies to ANY text the user
# might see — captions, hooks, titles, descriptions, scripts, dub text.
NUMBERS_AS_DIGITS = (
    "NUMBERS / PRICES / DURATIONS / COUNTS — always digits, never words:\n"
    "  • Currency: \"fifteen dollars\" / \"pandrah dollar\" / \"quince dólares\" → \"$15\".\n"
    "  • Currency: \"hundred dollars\" / \"sau dollar\" → \"$100\".\n"
    "  • Durations: \"seven days\" / \"saat din\" → \"7 days\" / \"7 din\".\n"
    "  • Counts: \"fifty users\" → \"50 users\".\n"
    "  • EVERY plain numeral 0-100, in any language, becomes a digit. "
    "Especially common in Urdu / Hindi / Roman Urdu where numbers get "
    "spelled out:\n"
    "      ek → 1, do → 2, teen → 3, char → 4, paanch / panch → 5,\n"
    "      cheh / chhe → 6, saat → 7, aath → 8, nau → 9, das → 10,\n"
    "      gyarah → 11, barah → 12, terah → 13, chaudah → 14, pandrah → 15,\n"
    "      sola → 16, satrah → 17, atharah → 18, unnees → 19, bees → 20,\n"
    "      pachees → 25, tees → 30, chalees → 40, pachas → 50, saath → 60,\n"
    "      sattar → 70, assi → 80, nabbe → 90, sau → 100, hazaar → 1000.\n"
    "      Same for Hindi: \"ek do major developments\" → \"1, 2 major developments\".\n"
    "  • Apply regardless of language. Whether the input is Urdu, Hindi, "
    "Roman Urdu, Arabic, Spanish, French — the digit form is what creators "
    "actually use in subtitles and viral hooks.\n"
    "  • DO NOT convert ordinals/positions if they aren't already a count "
    "(e.g. \"sab se pehle\" / \"firstly\" stays — that's a transition phrase, "
    "not a count). DO convert when it's clearly a count: \"do major points\" → \"2 major points\".\n"
    "  • EXCEPTION: numbers in brand names / established phrases (\"Web3\", "
    "\"24/7\", \"Twenty-One Pilots\") stay as the brand's official form."
)

# Brand names should land on their canonical spelling.
BRAND_CANONICAL = (
    "BRAND / PRODUCT / PERSON NAMES — use the canonical spelling:\n"
    "  • \"By Bit\" / \"BiBit\" → \"Bybit\"\n"
    "  • \"X Twitter\" → \"X (Twitter)\" or just \"X\"\n"
    "  • \"Aliana Mask\" → \"Elon Musk\"\n"
    "  • \"Ouvert\" → \"OpenAI\"\n"
    "  • \"Tick Tock\" → \"TikTok\"\n"
    "  • Use the official capitalisation and punctuation from the brand's "
    "own website / wordmark."
)

# Don't drop substantive content. Most failure mode in cleanup prompts.
NEVER_DROP = (
    "ZERO CONTENT LOSS — most important rule for transcript-style work:\n"
    "  • If a phrase looks like noise to you, KEEP IT. The user reviews "
    "and removes — not you.\n"
    "  • Never drop a clause that adds factual content (a price, a "
    "duration, a condition, a name, a step in a process).\n"
    "  • The ONLY thing you may drop is verbatim repetition like "
    "\"$100 with a $100 with a\" → \"$100 with a\"."
)

# Use surrounding context aggressively — but only when the proposed
# replacement is phonetically close to the original. Without that
# guardrail the model over-corrects and replaces real, intentional
# words (especially idiomatic ones) with topic-flavoured words that
# don't sound anything like what the speaker actually said.
USE_CONTEXT_HARD = (
    "CONTEXT-DRIVEN CORRECTION — fix Whisper mishears using the "
    "surrounding topic, but ONLY when the replacement passes the "
    "phonetic-similarity test.\n"
    "  • FIRST: identify the TOPIC of the full clip from the context "
    "below (trading? cooking? cybersecurity?). Topic only narrows "
    "WHICH soundalike is the intended word — it does NOT license "
    "swapping a real word for a topic-flavoured one.\n"
    "  • PHONETIC RULE (mandatory): a replacement is only valid if it "
    "sounds like the original — same number of syllables (±1), same "
    "stressed vowels, same starting consonant cluster. Two words being "
    "in the same domain is NOT enough.\n"
    "  • Idioms and figurative language are sacred. Speakers in a "
    "trading video routinely reach for non-trading metaphors — "
    "lottery, jackpot, gold mine, fishing, jugaad, chai. If Whisper "
    "wrote a real word that fits the SENTENCE (even if it doesn't fit "
    "the topic), KEEP IT.\n"
    "  • When in doubt, prefer the original Whisper word. Over-"
    "correction is a worse failure mode than missing one mishear.\n"
    "  • CORRECT examples — phonetically close, fixes a clear mishear:\n"
    "      - Topic = trading / crypto. Whisper wrote \"laga den ek ya "
    "do trail\" → \"laga den ek ya do trade\" (\"trail\"≈\"trade\").\n"
    "      - Topic = trading. Whisper wrote \"open a trail account\" "
    "→ \"open a trade account\".\n"
    "      - Topic = cooking. Whisper wrote \"add a tea spoon of solt\" "
    "→ \"add a teaspoon of salt\".\n"
    "      - Topic = visiting a site. Whisper wrote \"han par ane ke "
    "baad\" → \"yahan ane ke baad\".\n"
    "      - Topic = crypto wallets. Whisper wrote \"crypto wallit\" → "
    "\"crypto wallet\".\n"
    "      - Generic typo. Whisper wrote \"there account\" → \"their "
    "account\".\n"
    "  • WRONG examples — phonetic stretch, swaps a real idiomatic "
    "word for a topic word. DO NOT do these:\n"
    "      - Topic = crypto. Whisper wrote \"aap ki lottery nikalne "
    "wali hai\" — keep \"lottery\". DO NOT change to \"liquidation\". "
    "\"Lottery\" is an Urdu/Hindi idiom for \"jackpot\" and the "
    "speaker meant exactly that. \"Liquidation\" is a phonetic stretch "
    "and changes the meaning entirely.\n"
    "      - Topic = trading. Whisper wrote \"chai pe baat karte "
    "hain\" — keep \"chai\". DO NOT change to \"chart\".\n"
    "      - Topic = fitness. Whisper wrote \"khud ko push karo\" — "
    "keep \"push\". DO NOT change to \"bench\".\n"
    "  • If a line is mid-sentence and the audio clearly continues, do "
    "NOT shorten it to a clean sentence — keep all the words."
)

# Roman Urdu / Hinglish has well-known Whisper failure modes that the
# generic "phonetic-similarity" rule above misses because the model
# doesn't know Urdu phonology. We list them here as concrete swaps so
# the model fixes them every time, not when it feels like it.
#
# These came directly from production failures the user reported, so
# they're the exact mishears we keep seeing — not a generic list.
ROMAN_URDU_SPELLING = (
    "ROMAN URDU / HINGLISH SPELLING — apply these every time, no exceptions:\n"
    "\n"
    "  1. RETROFLEX 'ر' / 'ڑ' → ALWAYS write as 'r', never 'd'. Whisper\n"
    "     hears the retroflex flap as a 'd' sound and writes 'd', but\n"
    "     in Roman Urdu the convention is 'r' (or 'rr'). Examples:\n"
    "       • \"badi\" → \"bari\"  (بڑی = big, fem.)\n"
    "       • \"bada\" → \"bara\"  (بڑا = big, masc.)\n"
    "       • \"thodi\" → \"thori\" (تھوڑی = a little, fem.)\n"
    "       • \"thoda\" → \"thora\" (تھوڑا = a little, masc.)\n"
    "       • \"ladka\" → \"larka\" (لڑکا = boy)\n"
    "       • \"ladki\" → \"larki\" (لڑکی = girl)\n"
    "       • \"padhna\" → \"parhna\" (پڑھنا = to read)\n"
    "       • \"chhodna\" → \"chorna\" (چھوڑنا = to leave)\n"
    "       • \"jaldi\" stays \"jaldi\" — that 'd' is a real 'د', not retroflex.\n"
    "\n"
    "  2. COMMON WHISPER MISHEARS that come up constantly. ALWAYS fix:\n"
    "       • \"tareefan\" / \"tareeban\" / \"tarefan\" → \"takreeban\"\n"
    "         (تقریباً = approximately. Whisper drops the 'k' sound.)\n"
    "       • \"chose\" / \"choze\" (in Urdu sentences) → \"choose\"\n"
    "         (English loanword in a Roman-Urdu line.)\n"
    "       • \"shart\" / \"sharat\" stays \"shart\" (شرط = condition).\n"
    "       • \"misaal ke tor pe\" → \"misal ke taur pe\" (طور = manner).\n"
    "       • \"baajaye\" / \"bajaye\" / \"bajaaye\" → \"bajaye\" (بجائے).\n"
    "       • \"zariya\" → \"zariye\" when it means \"via/through\" (ذریعے).\n"
    "       • \"poochta\" → \"puchta\" / \"poochhta\" — keep aspirated 'ch' sound.\n"
    "\n"
    "  3. CONSISTENCY — pick one Roman spelling for each Urdu word and\n"
    "     stick with it through the whole transcript. If you write\n"
    "     'bari' once, never write 'badi' again in the same clip.\n"
    "\n"
    "  4. These rules are STRONGER than the phonetic-similarity rule\n"
    "     above. The retroflex-r and tareefan→takreeban swaps are not\n"
    "     up for debate — they are spelling normalisations, not\n"
    "     content edits. Apply them even if Whisper's version 'sounds\n"
    "     close enough'."
)


# Crypto / finance / tech vocabulary that gets MURDERED when an LLM
# translates a Roman-Urdu / Hinglish / Arabic source word-for-word.
# These are FIXED TERMS OF ART — they exist in every language as the
# English word, not as a translation. The classic failure was
# "Yield Farming" → "Young farmers in the fields" (a real LLM output
# from a crypto song the user uploaded), where the model translated
# the LITERAL meaning of what it thought it heard rather than
# recognising the crypto jargon. This block stops that.
CRYPTO_FINANCE_GLOSSARY = (
    "CRYPTO / FINANCE / TECH GLOSSARY — these terms NEVER translate.\n"
    "They are fixed English jargon used identically in every language:\n"
    "\n"
    "  Major coins / L1 chains:\n"
    "    Bitcoin (BTC), Ethereum (ETH), Litecoin (LTC), XRP (Ripple),\n"
    "    Solana (SOL), Cardano (ADA), Dogecoin (DOGE), USDT, USDC,\n"
    "    BNB, Polygon (MATIC), Avalanche (AVAX), Tron (TRX),\n"
    "    Polkadot (DOT), Cosmos (ATOM), Near, Sui, Aptos, Toncoin (TON).\n"
    "\n"
    "  Layer-2s & rollups (canonical capitalization):\n"
    "    Optimism (OP), Arbitrum (ARB), Base, Scroll, zkSync, Starknet,\n"
    "    Linea, Blast, Mantle, Polygon zkEVM, Manta.\n"
    "\n"
    "  Cross-chain / messaging / oracle infra:\n"
    "    LayerZero ($ZRO / ZK), Wormhole (W), Axelar (AXL),\n"
    "    ChainLink (LINK), Pyth, API3, Celestia (TIA), EigenDA,\n"
    "    Hyperlane.\n"
    "\n"
    "  Restaking / liquid-staking / yield protocols:\n"
    "    EigenLayer, KelpDAO ($KELP), ether.fi (ETHFI), Renzo (REZ),\n"
    "    Puffer, Lido (LDO), Rocket Pool (RPL), Frax (FXS),\n"
    "    Pendle (PENDLE), Karak.\n"
    "\n"
    "  DeFi / DEX / lending:\n"
    "    Uniswap (UNI), Curve (CRV), Aave (AAVE), Compound (COMP),\n"
    "    MakerDAO (MKR), Sky, Sushi, Balancer (BAL), Jupiter (JUP),\n"
    "    Raydium, GMX, dYdX, Synthetix (SNX), 1inch.\n"
    "\n"
    "  Memecoins & narratives:\n"
    "    PEPE, SHIB, WIF, BONK, FLOKI, BRETT, POPCAT, MOG.\n"
    "\n"
    "  Exchanges / CEXs:\n"
    "    Binance, Coinbase, Kraken, OKX, Bybit, KuCoin, Bitfinex,\n"
    "    Gate.io, MEXC, HTX, Crypto.com.\n"
    "\n"
    "  Concepts (most-mistranslated bolded — preserve EXACTLY):\n"
    "    *Yield Farming*, *DeFi*, *TradFi*, *CeFi*, *NFT*, *DAO*,\n"
    "    *L1*, *L2*, *Layer 1*, *Layer 2*, *Layer 0*, *Restaking*,\n"
    "    *Liquid Staking*, *LST*, *LRT*, *MEV*, *Slashing*,\n"
    "    *Governance*, *Treasury*, *Vault*, *Airdrop*, *Snapshot*,\n"
    "    *RWA*, *Real World Assets*, *ICO*, *IDO*, *IEO*,\n"
    "    *Smart Contract(s)*, *Tokenized Stocks*, *P2P*,\n"
    "    *Proof of Stake*, *Proof of Work*, *Halving*, *Mining*,\n"
    "    *Staking*, *Liquidity*, *Liquidation*, *Stablecoin*,\n"
    "    *AMM*, *DEX*, *CEX*, *Cross-chain*, *Bridge*, *Gas*,\n"
    "    *Mempool*, *Hash*, *Hashrate*, *Bull market*, *Bear market*,\n"
    "    *FUD*, *FOMO*, *HODL*, *Whale*, *Pump*, *Dump*, *Rugpull*,\n"
    "    *Validator*, *Sequencer*, *Prover*, *Relayer*, *Oracle*,\n"
    "    *TVL*, *APR*, *APY*, *Catalyst*.\n"
    "\n"
    "  Historical references the source may name:\n"
    "    Satoshi, Satoshi Nakamoto, eCash, HashCash, Bit-Gold,\n"
    "    Genesis block, Mt. Gox, Silk Road.\n"
    "\n"
    "  Token-ticker convention:\n"
    "    Tickers prefixed with $ are written as the bare uppercase\n"
    "    symbol prefixed with the dollar sign — e.g. $BTC, $ETH,\n"
    "    $ZK, $ZRO, $KELP, $ETHFI, $REZ, $LINK. When the speaker\n"
    "    says \"the ZK token\" / \"$ZK token\" / \"ZK ka token\" /\n"
    "    \"ZK wala token\", output \"$ZK token\". Do NOT lowercase\n"
    "    a ticker. Do NOT translate \"token\" — keep it as \"token\".\n"
    "\n"
    "RECOGNITION RULES — when the source has these phonetically:\n"
    "  • If you see something that SOUNDS like one of these terms in\n"
    "    a non-English script or Roman-Urdu spelling, recognize it as\n"
    "    the crypto term. Do NOT translate the literal Urdu/Hindi\n"
    "    word it phonetically resembles.\n"
    "  • Examples that have BURNED in production — never repeat:\n"
    "      • \"Yield Farming\" must NEVER become \"young farmers\".\n"
    "        It is the DeFi practice of providing liquidity for\n"
    "        token rewards. Output: \"Yield Farming\".\n"
    "      • \"DeFi TradFi\" / \"Di Fi Tradi Fi\" must NEVER become\n"
    "        \"defy, terrify\". Output: \"DeFi and TradFi\".\n"
    "      • \"L1 competitors\" must stay \"L1 competitors\". Do NOT\n"
    "        invert it to \"L1's vision faded\".\n"
    "      • \"chakna-choor\" (Roman Urdu for \"shattered\") must NOT\n"
    "        become \"checkmate\". Translate as \"shattered\" or\n"
    "        \"crushed\".\n"
    "      • \"30 projects veeraan\" (30 projects destroyed/laid waste)\n"
    "        is a NEGATIVE event — translate accordingly. Do NOT\n"
    "        invert to \"30 projects launched/turning on\".\n"
    "      • Whisper often hears \"KelpDAO\" as \"clip down\" /\n"
    "          \"kelp dow\" / \"calp dao\" / \"clipdown\". When the\n"
    "          surrounding topic is restaking, EigenLayer, ETH, LRT,\n"
    "          or yield, output \"KelpDAO\". Same pattern for\n"
    "          ether.fi → \"either fi\", Renzo → \"renzo\" (rare\n"
    "          mishears), Puffer → \"puffer\".\n"
    "      • Whisper often hears \"ChainLink\" as \"chain link\"\n"
    "          (two words, lowercase). When the surrounding topic\n"
    "          is oracles, price feeds, LINK token, or cross-chain,\n"
    "          output \"ChainLink\" (one word, PascalCase) — that's\n"
    "          the canonical brand spelling.\n"
    "      • Whisper often hears \"LayerZero\" as \"layer zero\" /\n"
    "          \"layer ziro\" / \"lair zero\". When the surrounding\n"
    "          topic is omnichain messaging, $ZRO, $ZK token,\n"
    "          interoperability, or bridges, output \"LayerZero\"\n"
    "          (one word, PascalCase). Note: this is DIFFERENT\n"
    "          from \"Layer 1\" / \"Layer 2\" — those are abstract\n"
    "          chain tiers, LayerZero is a specific protocol.\n"
    "      • Whisper often hears \"BIG question\" as \"bug question\"\n"
    "          / \"big quest\" / \"bag question\". When it follows\n"
    "          a noun phrase and is followed by \"mark\", treat it\n"
    "          as the English idiom \"BIG question mark\". Output\n"
    "          \"BIG question mark\" (English, capitalised \"BIG\"\n"
    "          for emphasis when the speaker stressed it).\n"
    "      • Common short English fillers Whisper mangles in\n"
    "          mixed-script speech — restore the canonical English:\n"
    "          \"bug\" → \"BIG\" (when context demands emphasis),\n"
    "          \"shift\" stays \"shift\" (do not translate to\n"
    "          \"badalna\"), \"trading positions\" stays\n"
    "          \"trading positions\", \"market\" stays \"market\",\n"
    "          \"investment\" stays \"investment\", \"adjust\" stays\n"
    "          \"adjust\", \"protocol\" stays \"protocol\",\n"
    "          \"utility\" stays \"utility\", \"catalyst\" stays\n"
    "          \"catalyst\", \"hack\" stays \"hack\", \"recent\" stays\n"
    "          \"recent\", \"development\" stays \"development\".\n"
    "  • When unsure whether a foreign-script word is a crypto term\n"
    "    or a literal phrase, the topic of the surrounding text is\n"
    "    your tiebreaker — but ONLY when phonetics support it.\n"
    "\n"
    "OUTPUT RULE: keep all glossary terms in their CANONICAL English\n"
    "spelling (e.g. \"DeFi\" not \"De Fi\", \"NFT\" not \"N. F. T.\",\n"
    "\"ChainLink\" not \"chain link\", \"LayerZero\" not \"layer zero\",\n"
    "\"KelpDAO\" not \"kelp dao\")."
)


# Songs are different from speech: the same line repeats verbatim as
# a chorus, lines rhyme, structure tags ([Verse], [Chorus], [Bridge])
# carry meaning. A subtitle pipeline tuned for podcasts produces
# garbage on songs because each chorus repeat gets paraphrased
# differently. This block teaches the LLM to recognize song shape.
SONG_AWARENESS = (
    "SONG / LYRICS HANDLING — apply when the source looks like lyrics:\n"
    "  Detection signals (any one is enough):\n"
    "    • Multiple identical or near-identical lines = chorus.\n"
    "    • Lines end in rhyming syllables / similar consonant patterns.\n"
    "    • Bracketed structure tags ([Intro], [Verse N], [Chorus],\n"
    "      [Bridge], [Outro], [Female Vocals], [Spoken Word]).\n"
    "    • Source includes the word \"chorus\" or \"verse\" verbatim.\n"
    "\n"
    "  Rules when input is a song:\n"
    "    1. CHORUS REPETITION IS SACRED. If the same line (or the\n"
    "       same 4-8 line block) appears more than once in the\n"
    "       source, it MUST translate to the EXACT SAME output\n"
    "       string every time. Do NOT paraphrase chorus repeats —\n"
    "       that's the #1 thing that breaks song subtitling.\n"
    "    2. Match the LINE COUNT of each verse. A 4-line verse\n"
    "       produces 4 output lines, not 3, not 5.\n"
    "    3. Keep brand / glossary words untranslated even when they\n"
    "       break a rhyme — accuracy beats rhyme.\n"
    "    4. When [Verse]/[Chorus]/[Bridge] tags are present in the\n"
    "       INPUT, preserve them verbatim in the output (do not\n"
    "       translate the tags themselves).\n"
    "    5. For purely lyrical / poetic content, LIGHT rhythm-aware\n"
    "       translation is welcome (matching syllable count loosely)\n"
    "       but never at the cost of meaning."
)


# Composite: rules every USER-FACING text generator should follow.
# Captions, hooks, titles, descriptions, scripts.
USER_TEXT_RULES = (
    "===== USER-FACING TEXT RULES (mandatory) =====\n"
    f"{NUMBERS_AS_DIGITS}\n\n"
    f"{BRAND_CANONICAL}\n"
    "============================================="
)

# Composite: rules every TRANSCRIPT REWRITE prompt should follow
# (cleanup, Roman transliteration, translation). Includes the content-
# preservation rule that doesn't apply to creative-write prompts like
# "make a viral hook".
TRANSCRIPT_REWRITE_RULES = (
    "===== TRANSCRIPT REWRITE RULES (mandatory) =====\n"
    f"{NEVER_DROP}\n\n"
    f"{USE_CONTEXT_HARD}\n\n"
    f"{NUMBERS_AS_DIGITS}\n\n"
    f"{BRAND_CANONICAL}\n\n"
    f"{ROMAN_URDU_SPELLING}\n"
    "================================================"
)
