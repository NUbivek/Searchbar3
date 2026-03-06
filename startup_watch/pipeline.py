import csv
import datetime as dt
import os
import time

import yaml

from startup_watch.adapters.a16z import A16zAdapter
from startup_watch.adapters.agdaily import AgdailyAdapter
from startup_watch.adapters.agfunder_news import AgfunderNewsAdapter
from startup_watch.adapters.agfunder import AgfunderAdapter
from startup_watch.adapters.agfunder_pod import AgfunderPodAdapter
from startup_watch.adapters.agriinvestor import AgriinvestorAdapter
from startup_watch.adapters.agweb import AgwebAdapter
from startup_watch.adapters.antler import AntlerAdapter
from startup_watch.adapters.angellist_startups import AngellistStartupsAdapter
from startup_watch.adapters.alchemist import AlchemistAdapter
from startup_watch.adapters.atdc import AtdcAdapter
from startup_watch.adapters.berkeley_skydeck import BerkeleySkydeckAdapter
from startup_watch.adapters.dealroom import DealroomAdapter
from startup_watch.adapters.cornell_tech import CornellTechAdapter
from startup_watch.adapters.climateinsider import ClimateinsiderAdapter
from startup_watch.adapters.crunchbase_news import CrunchbaseNewsAdapter
from startup_watch.adapters.cleanenergywire import CleanenergywireAdapter
from startup_watch.adapters.bessemer import BessemerAdapter
from startup_watch.adapters.supplychaindive import SupplychaindiveAdapter
from startup_watch.adapters.betalist import BetalistAdapter
from startup_watch.adapters.linkedin import LinkedInAdapter
from startup_watch.adapters.industryweek import IndustryweekAdapter
from startup_watch.adapters.iiot_world import IiotWorldAdapter
from startup_watch.adapters.indiehackers import IndiehackersAdapter
from startup_watch.adapters.logisticsmgmt import LogisticsmgmtAdapter
from startup_watch.adapters.mit_deltav import MitDeltavAdapter
from startup_watch.adapters.plugandplay_sc import PlugandplayScAdapter
from startup_watch.adapters.plugandplay_food import PlugandplayFoodAdapter
from startup_watch.adapters.pitchbook_blog import PitchbookBlogAdapter
from startup_watch.adapters.producthunt import ProducthuntAdapter
from startup_watch.adapters.reddit_startups import RedditStartupsAdapter
from startup_watch.adapters.freightwaves import FreightwavesAdapter
from startup_watch.adapters.foodbytes import FoodbytesAdapter
from startup_watch.adapters.gust import GustAdapter
from startup_watch.adapters.fivehundred_global import FivehundredGlobalAdapter
from startup_watch.adapters.hackernews import HackernewsAdapter
from startup_watch.adapters.harvard_ilab import HarvardIlabAdapter
from startup_watch.adapters.eu_startups import EuStartupsAdapter
from startup_watch.adapters.enterprise_ireland import EnterpriseIrelandAdapter
from startup_watch.adapters.eth_pioneer import EthPioneerAdapter
from startup_watch.adapters.eit_food import EitFoodAdapter
from startup_watch.adapters.f6s import F6sAdapter
from startup_watch.adapters.firstround import FirstroundAdapter
from startup_watch.adapters.future_ag import FutureAgAdapter
from startup_watch.adapters.iot_analytics import IotAnalyticsAdapter
from startup_watch.adapters.manufacturing_net import ManufacturingNetAdapter
from startup_watch.adapters.masschallenge import MasschallengeAdapter
from startup_watch.adapters.mfg_dive import MfgDiveAdapter
from startup_watch.adapters.mmh import MmhAdapter
from startup_watch.adapters.owler import OwlerAdapter
from startup_watch.adapters.oxford_foundry import OxfordFoundryAdapter
from startup_watch.adapters.openvc import OpenvcAdapter
from startup_watch.adapters.sequoia import SequoiaAdapter
from startup_watch.adapters.stanford_startx import StanfordStartxAdapter
from startup_watch.adapters.startupstream import StartupStreamAdapter
from startup_watch.adapters.startupland import StartuplandAdapter
from startup_watch.adapters.startup_genome import StartupGenomeAdapter
from startup_watch.adapters.smart_industry import SmartIndustryAdapter
from startup_watch.adapters.skydeck_fund import SkydeckFundAdapter
from startup_watch.adapters.sifted import SiftedAdapter
from startup_watch.adapters.spendmatters import SpendmattersAdapter
from startup_watch.adapters.s2g_companies import S2gCompaniesAdapter
from startup_watch.adapters.seedtable import SeedtableAdapter
from startup_watch.adapters.techcrunch_funding import TechcrunchFundingAdapter
from startup_watch.adapters.tech_eu import TechEuAdapter
from startup_watch.adapters.techstars import TechstarsAdapter
from startup_watch.adapters.techfundingnews import TechfundingnewsAdapter
from startup_watch.adapters.techinasia import TechinasiaAdapter
from startup_watch.adapters.tractica_ai import TracticaAiAdapter
from startup_watch.adapters.siliconcanals import SiliconcanalsAdapter
from startup_watch.adapters.vestbee import VestbeeAdapter
from startup_watch.adapters.startupdaily import StartupdailyAdapter
from startup_watch.adapters.yourstory import YourstoryAdapter
from startup_watch.adapters.builtin import BuiltinAdapter
from startup_watch.adapters.euvc import EuvcAdapter
from startup_watch.adapters.sifted_news import SiftedNewsAdapter
from startup_watch.adapters.unicornnest import UnicornnestAdapter
from startup_watch.adapters.startupnewsfyi import StartupnewsfyiAdapter
from startup_watch.adapters.latitud import LatitudAdapter
from startup_watch.adapters.refreshmiami import RefreshmiamiAdapter
from startup_watch.adapters.geekwire import GeekwireAdapter
from startup_watch.adapters.thenextweb import ThenextwebAdapter
from startup_watch.adapters.e27 import E27Adapter
from startup_watch.adapters.startupbeat import StartupbeatAdapter
from startup_watch.adapters.entrepreneurshiplife import EntrepreneurshiplifeAdapter
from startup_watch.adapters.innovationorigins import InnovationoriginsAdapter
from startup_watch.adapters.startupsmagazine import StartupsmagazineAdapter
from startup_watch.adapters.vccircle import VccircleAdapter
from startup_watch.adapters.techpoint_africa import TechpointAfricaAdapter
from startup_watch.adapters.disruptafrica import DisruptafricaAdapter
from startup_watch.adapters.vested import VestedAdapter
from startup_watch.adapters.therecursive import TherecursiveAdapter
from startup_watch.adapters.siliconrepublic import SiliconrepublicAdapter
from startup_watch.adapters.itweb_africa import ItwebAfricaAdapter
from startup_watch.adapters.startupill import StartupillAdapter
from startup_watch.adapters.devdiscourse import DevdiscourseAdapter
from startup_watch.adapters.techbuild_africa import TechbuildAfricaAdapter
from startup_watch.adapters.futurescot import FuturescotAdapter
from startup_watch.adapters.techcabal import TechcabalAdapter
from startup_watch.adapters.benjamindada import BenjamindadaAdapter
from startup_watch.adapters.technext_ng import TechnextNgAdapter
from startup_watch.adapters.techafricanews import TechafricanewsAdapter
from startup_watch.adapters.techtrendske import TechtrendskeAdapter
from startup_watch.adapters.tech_ish import TechIshAdapter
from startup_watch.adapters.techmoran import TechmoranAdapter
from startup_watch.adapters.memeburn import MemeburnAdapter
from startup_watch.adapters.weetracker import WeetrackerAdapter
from startup_watch.adapters.techweez import TechweezAdapter
from startup_watch.adapters.ventureburn import VentureburnAdapter
from startup_watch.adapters.venturesafrica import VenturesafricaAdapter
from startup_watch.adapters.inc42 import Inc42Adapter
from startup_watch.adapters.entrackr import EntrackrAdapter
from startup_watch.adapters.dealstreetasia import DealstreetasiaAdapter
from startup_watch.adapters.techloy import TechloyAdapter
from startup_watch.adapters.kr_asia import KrAsiaAdapter
from startup_watch.adapters.technode import TechnodeAdapter
from startup_watch.adapters.techsauce import TechsauceAdapter
from startup_watch.adapters.echelonasia import EchelonasiaAdapter
from startup_watch.adapters.technin_asia import TechninAsiaAdapter
from startup_watch.adapters.vulcanpost import VulcanpostAdapter
from startup_watch.adapters.pandaily import PandailyAdapter
from startup_watch.adapters.wamda import WamdaAdapter
from startup_watch.adapters.maddyness import MaddynessAdapter
from startup_watch.adapters.techfundingasia import TechfundingasiaAdapter
from startup_watch.adapters.startupnewsasia import StartupnewsasiaAdapter
from startup_watch.adapters.vietcetera import VietceteraAdapter
from startup_watch.adapters.bloomingstartup import BloomingstartupAdapter
from startup_watch.adapters.africanbusiness_tech import AfricanbusinessTechAdapter
from startup_watch.adapters.menabytes import MenabytesAdapter
from startup_watch.adapters.magnitt import MagnittAdapter
from startup_watch.adapters.wadi_mena import WadiMenaAdapter
from startup_watch.adapters.startupbahrain import StartupbahrainAdapter
from startup_watch.adapters.techjuice import TechjuiceAdapter
from startup_watch.adapters.pakwired import PakwiredAdapter
from startup_watch.adapters.dailysocial import DailysocialAdapter
from startup_watch.adapters.techstartups import TechstartupsAdapter
from startup_watch.adapters.startupnewsme import StartupnewsmeAdapter
from startup_watch.adapters.middleeastventures import MiddleeastventuresAdapter
from startup_watch.adapters.europeanstartups import EuropeanstartupsAdapter
from startup_watch.adapters.startupobserver import StartupobserverAdapter
from startup_watch.adapters.startupsavant import StartupsavantAdapter
from startup_watch.adapters.techrasa import TechrasaAdapter
from startup_watch.adapters.techgistafrica import TechgistafricaAdapter
from startup_watch.adapters.itnewsafrica import ItnewsafricaAdapter
from startup_watch.adapters.disfold_blog import DisfoldBlogAdapter
from startup_watch.adapters.startupradius import StartupradiusAdapter
from startup_watch.adapters.nextbigwhat import NextbigwhatAdapter
from startup_watch.adapters.techcircle import TechcircleAdapter
from startup_watch.adapters.siliconangle_startups import SiliconangleStartupsAdapter
from startup_watch.adapters.readwrite_startups import ReadwriteStartupsAdapter
from startup_watch.adapters.techinformed import TechinformedAdapter
from startup_watch.adapters.startupdaily_africa import StartupdailyAfricaAdapter
from startup_watch.adapters.techlabari import TechlabariAdapter
from startup_watch.adapters.innov8tiv import Innov8tivAdapter
from startup_watch.adapters.smesouthafrica import SmesouthafricaAdapter
from startup_watch.adapters.techawkng import TechawkngAdapter
from startup_watch.adapters.technovagh import TechnovaghAdapter
from startup_watch.adapters.afritechie import AfritechieAdapter
from startup_watch.adapters.frenchweb import FrenchwebAdapter
from startup_watch.adapters.maddyness_fr import MaddynessFrAdapter
from startup_watch.adapters.gruenderszene import GruenderszeneAdapter
from startup_watch.adapters.siliconallee import SiliconalleeAdapter
from startup_watch.adapters.siftedeu_news import SiftedeuNewsAdapter
from startup_watch.adapters.arcticstartup import ArcticstartupAdapter
from startup_watch.adapters.eu_startups_news import EuStartupsNewsAdapter
from startup_watch.adapters.uktechnews import UktechnewsAdapter
from startup_watch.adapters.irishtechnews import IrishtechnewsAdapter
from startup_watch.adapters.techpluto import TechplutoAdapter
from startup_watch.adapters.siliconrepublic_startups import SiliconrepublicStartupsAdapter
from startup_watch.adapters.techforge_media import TechforgeMediaAdapter
from startup_watch.adapters.sifted_pro import SiftedProAdapter
from startup_watch.adapters.foundersguide import FoundersguideAdapter
from startup_watch.adapters.startupvalley_news import StartupvalleyNewsAdapter
from startup_watch.adapters.techbehemoths_blog import TechbehemothsBlogAdapter
from startup_watch.adapters.startupscoot import StartupscootAdapter
from startup_watch.adapters.seedrs_insights import SeedrsInsightsAdapter
from startup_watch.adapters.euvc_insights import EuvcInsightsAdapter
from startup_watch.adapters.startupmag_europe import StartupmagEuropeAdapter
from startup_watch.adapters.vator_startups import VatorStartupsAdapter
from startup_watch.adapters.startus_insights import StartusInsightsAdapter
from startup_watch.adapters.tracxn_blog import TracxnBlogAdapter
from startup_watch.adapters.f6s_news import F6sNewsAdapter
from startup_watch.adapters.euvc_deals import EuvcDealsAdapter
from startup_watch.adapters.venturecapitaljournal import VenturecapitaljournalAdapter
from startup_watch.adapters.privateequitywire_vc import PrivateequitywireVcAdapter
from startup_watch.adapters.globalventuring import GlobalventuringAdapter
from startup_watch.adapters.thehumancapital import ThehumancapitalAdapter
from startup_watch.adapters.startupsatellite import StartupsatelliteAdapter
from startup_watch.adapters.startupgenius import StartupgeniusAdapter
from startup_watch.adapters.founderjar import FounderjarAdapter
from startup_watch.adapters.smallbiztrends_startups import SmallbiztrendsStartupsAdapter
from startup_watch.adapters.startupgrind_blog import StartupgrindBlogAdapter
from startup_watch.adapters.forentrepreneurs import ForentrepreneursAdapter
from startup_watch.adapters.bothsidesofthetable import BothsidesofthetableAdapter
from startup_watch.adapters.avc_blog import AvcBlogAdapter
from startup_watch.adapters.feldthoughts import FeldthoughtsAdapter
from startup_watch.adapters.saastr_blog import SaastrBlogAdapter
from startup_watch.adapters.tomtunguz import TomtunguzAdapter
from startup_watch.adapters.openhubstartup import OpenhubstartupAdapter
from startup_watch.adapters.startuptalky import StartuptalkyAdapter
from startup_watch.adapters.yourtechtoday import YourtechtodayAdapter
from startup_watch.adapters.techsafariz import TechsafarizAdapter
from startup_watch.adapters.africatechdaily import AfricatechdailyAdapter
from startup_watch.adapters.startupnewszone import StartupnewszoneAdapter
from startup_watch.adapters.venturefounders import VenturefoundersAdapter
from startup_watch.adapters.newstartupmedia import NewstartupmediaAdapter
from startup_watch.adapters.seedfundnews import SeedfundnewsAdapter
from startup_watch.adapters.techpulsefounders import TechpulsefoundersAdapter
from startup_watch.adapters.startupreporter import StartupreporterAdapter
from startup_watch.adapters.foundersradar import FoundersradarAdapter
from startup_watch.adapters.deeptechdigest import DeeptechdigestAdapter
from startup_watch.adapters.futurefoundersnews import FuturefoundersnewsAdapter
from startup_watch.adapters.nextventuredaily import NextventuredailyAdapter
from startup_watch.adapters.startupwireglobal import StartupwireglobalAdapter
from startup_watch.adapters.frontierstartups import FrontierstartupsAdapter
from startup_watch.adapters.climatestartupsnews import ClimatestartupsnewsAdapter
from startup_watch.adapters.industriousventures import IndustriousventuresAdapter
from startup_watch.adapters.logisticstechnews import LogisticstechnewsAdapter
from startup_watch.adapters.agxstartupnews import AgxstartupnewsAdapter
from startup_watch.adapters.enterprisefoundry import EnterprisefoundryAdapter
from startup_watch.adapters.seedstageinsider import SeedstageinsiderAdapter
from startup_watch.adapters.vcsignalsdaily import VcsignalsdailyAdapter
from startup_watch.adapters.startupcurrents import StartupcurrentsAdapter
from startup_watch.adapters.venturechronicle import VenturechronicleAdapter
from startup_watch.adapters.foundersbriefing import FoundersbriefingAdapter
from startup_watch.adapters.supplychainbrain import SupplychainbrainAdapter
from startup_watch.adapters.greenqueen import GreenqueenAdapter
from startup_watch.adapters.finsmes import FinsmesAdapter
from startup_watch.adapters.sustainability_mag import SustainabilityMagAdapter
from startup_watch.adapters.thrive_agtech import ThriveAgtechAdapter
from startup_watch.adapters.therobotreport import TherobotreportAdapter
from startup_watch.adapters.wellfound import WellfoundAdapter
from startup_watch.adapters.venturebeat_ai import VenturebeatAiAdapter
from startup_watch.adapters.uw_comotion import UwComotionAdapter
from startup_watch.adapters.yc import YCombinatorAdapter
from startup_watch.dedup import deduplicate_signals
from startup_watch.enrichment import enrich_batch
from startup_watch.filters import filter_by_category, filter_by_stage, filter_excluded
from startup_watch.logger import get_logger
from startup_watch.schema import StartupSignal


def load_config(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def fetch_with_resilience(
    adapter: object,
    logger: object,
    retries: int,
    backoff_seconds: float,
) -> list[StartupSignal]:
    attempts = max(1, retries + 1)
    for attempt in range(1, attempts + 1):
        try:
            batch = adapter.fetch()
            logger.info("adapter=%s signals=%s attempt=%s", adapter.source_name, len(batch), attempt)
            return batch
        except Exception as exc:  # pragma: no cover - defensive guardrail
            logger.warning(
                "adapter=%s attempt=%s/%s error=%s",
                adapter.source_name,
                attempt,
                attempts,
                exc,
            )
            if attempt < attempts and backoff_seconds > 0:
                time.sleep(backoff_seconds * attempt)
    return []


def collect_signals(config: dict) -> list[StartupSignal]:
    logger = get_logger()
    pipeline_cfg = config.get("pipeline", {})
    retries = int(pipeline_cfg.get("adapter_retries", 1))
    backoff_seconds = float(pipeline_cfg.get("adapter_backoff_seconds", 0.5))
    delay_seconds = float(pipeline_cfg.get("adapter_delay_seconds", 0.0))

    adapters = [
        YCombinatorAdapter(config.get("yc_directory", {})),
        AgdailyAdapter(config.get("agdaily_adapter", {})),
        StartupStreamAdapter(config.get("startupstream", {})),
        LinkedInAdapter(config.get("linkedin", {})),
        MitDeltavAdapter(config.get("mit_deltav_adapter", {})),
        StanfordStartxAdapter(config.get("stanford_startx_adapter", {})),
        BerkeleySkydeckAdapter(config.get("berkeley_skydeck_adapter", {})),
        CornellTechAdapter(config.get("cornell_tech_adapter", {})),
        HarvardIlabAdapter(config.get("harvard_ilab_adapter", {})),
        OxfordFoundryAdapter(config.get("oxford_foundry_adapter", {})),
        EthPioneerAdapter(config.get("eth_pioneer_adapter", {})),
        UwComotionAdapter(config.get("uw_comotion_adapter", {})),
        AtdcAdapter(config.get("atdc_adapter", {})),
        TechstarsAdapter(config.get("techstars_adapter", {})),
        FivehundredGlobalAdapter(config.get("fivehundred_global_adapter", {})),
        AntlerAdapter(config.get("antler_adapter", {})),
        AlchemistAdapter(config.get("alchemist_adapter", {})),
        MasschallengeAdapter(config.get("masschallenge_adapter", {})),
        PlugandplayFoodAdapter(config.get("plugandplay_food_adapter", {})),
        StartuplandAdapter(config.get("startupland_adapter", {})),
        PlugandplayScAdapter(config.get("plugandplay_sc_adapter", {})),
        ThriveAgtechAdapter(config.get("thrive_agtech_adapter", {})),
        A16zAdapter(config.get("a16z_adapter", {})),
        SequoiaAdapter(config.get("sequoia_adapter", {})),
        BessemerAdapter(config.get("bessemer_adapter", {})),
        FirstroundAdapter(config.get("firstround_adapter", {})),
        SkydeckFundAdapter(config.get("skydeck_fund_adapter", {})),
        S2gCompaniesAdapter(config.get("s2g_companies_adapter", {})),
        DealroomAdapter(config.get("dealroom_adapter", {})),
        F6sAdapter(config.get("f6s_adapter", {})),
        OpenvcAdapter(config.get("openvc_adapter", {})),
        StartupGenomeAdapter(config.get("startup_genome_adapter", {})),
        OwlerAdapter(config.get("owler_adapter", {})),
        CrunchbaseNewsAdapter(config.get("crunchbase_news_adapter", {})),
        GustAdapter(config.get("gust_adapter", {})),
        EnterpriseIrelandAdapter(config.get("enterprise_ireland_adapter", {})),
        TechEuAdapter(config.get("tech_eu_adapter", {})),
        CleanenergywireAdapter(config.get("cleanenergywire_adapter", {})),
        SustainabilityMagAdapter(config.get("sustainability_mag_adapter", {})),
        ClimateinsiderAdapter(config.get("climateinsider_adapter", {})),
        AngellistStartupsAdapter(config.get("angellist_startups_adapter", {})),
        EuStartupsAdapter(config.get("eu_startups_adapter", {})),
        FutureAgAdapter(config.get("future_ag_adapter", {})),
        PitchbookBlogAdapter(config.get("pitchbook_blog_adapter", {})),
        SiftedAdapter(config.get("sifted_adapter", {})),
        AgriinvestorAdapter(config.get("agriinvestor_adapter", {})),
        SeedtableAdapter(config.get("seedtable_adapter", {})),
        TracticaAiAdapter(config.get("tractica_ai_adapter", {})),
        IiotWorldAdapter(config.get("iiot_world_adapter", {})),
        HackernewsAdapter(config.get("hackernews_adapter", {})),
        RedditStartupsAdapter(config.get("reddit_startups_adapter", {})),
        IndiehackersAdapter(config.get("indiehackers_adapter", {})),
        TechcrunchFundingAdapter(config.get("techcrunch_funding_adapter", {})),
        AgfunderNewsAdapter(config.get("agfunder_news_adapter", {})),
        AgfunderAdapter(config.get("agfunder_adapter", {})),
        EitFoodAdapter(config.get("eit_food_adapter", {})),
        FoodbytesAdapter(config.get("foodbytes_adapter", {})),
        AgfunderPodAdapter(config.get("agfunder_pod_adapter", {})),
        AgwebAdapter(config.get("agweb_adapter", {})),
        IndustryweekAdapter(config.get("industryweek_adapter", {})),
        FreightwavesAdapter(config.get("freightwaves_adapter", {})),
        WellfoundAdapter(config.get("wellfound_adapter", {})),
        BetalistAdapter(config.get("betalist_adapter", {})),
        ProducthuntAdapter(config.get("producthunt_adapter", {})),
        SpendmattersAdapter(config.get("spendmatters_adapter", {})),
        SmartIndustryAdapter(config.get("smart_industry_adapter", {})),
        IotAnalyticsAdapter(config.get("iot_analytics_adapter", {})),
        ManufacturingNetAdapter(config.get("manufacturing_net_adapter", {})),
        MfgDiveAdapter(config.get("mfg_dive_adapter", {})),
        MmhAdapter(config.get("mmh_adapter", {})),
        LogisticsmgmtAdapter(config.get("logisticsmgmt_adapter", {})),
        SupplychaindiveAdapter(config.get("supplychaindive_adapter", {})),
        TherobotreportAdapter(config.get("therobotreport_adapter", {})),
        VenturebeatAiAdapter(config.get("venturebeat_ai_adapter", {})),
        SupplychainbrainAdapter(config.get("supplychainbrain_adapter", {})),
        TechfundingnewsAdapter(config.get("techfundingnews_adapter", {})),
        GreenqueenAdapter(config.get("greenqueen_adapter", {})),
        FinsmesAdapter(config.get("finsmes_adapter", {})),
        SiliconcanalsAdapter(config.get("siliconcanals_adapter", {})),
        VestbeeAdapter(config.get("vestbee_adapter", {})),
        StartupdailyAdapter(config.get("startupdaily_adapter", {})),
        TechinasiaAdapter(config.get("techinasia_adapter", {})),
        YourstoryAdapter(config.get("yourstory_adapter", {})),
        BuiltinAdapter(config.get("builtin_adapter", {})),
        EuvcAdapter(config.get("euvc_adapter", {})),
        SiftedNewsAdapter(config.get("sifted_news_adapter", {})),
        UnicornnestAdapter(config.get("unicornnest_adapter", {})),
        StartupnewsfyiAdapter(config.get("startupnewsfyi_adapter", {})),
        LatitudAdapter(config.get("latitud_adapter", {})),
        RefreshmiamiAdapter(config.get("refreshmiami_adapter", {})),
        GeekwireAdapter(config.get("geekwire_adapter", {})),
        ThenextwebAdapter(config.get("thenextweb_adapter", {})),
        E27Adapter(config.get("e27_adapter", {})),
        StartupbeatAdapter(config.get("startupbeat_adapter", {})),
        EntrepreneurshiplifeAdapter(config.get("entrepreneurshiplife_adapter", {})),
        InnovationoriginsAdapter(config.get("innovationorigins_adapter", {})),
        StartupsmagazineAdapter(config.get("startupsmagazine_adapter", {})),
        VccircleAdapter(config.get("vccircle_adapter", {})),
        TechpointAfricaAdapter(config.get("techpoint_africa_adapter", {})),
        DisruptafricaAdapter(config.get("disruptafrica_adapter", {})),
        VestedAdapter(config.get("vested_adapter", {})),
        TherecursiveAdapter(config.get("therecursive_adapter", {})),
        SiliconrepublicAdapter(config.get("siliconrepublic_adapter", {})),
        ItwebAfricaAdapter(config.get("itweb_africa_adapter", {})),
        StartupillAdapter(config.get("startupill_adapter", {})),
        DevdiscourseAdapter(config.get("devdiscourse_adapter", {})),
        TechbuildAfricaAdapter(config.get("techbuild_africa_adapter", {})),
        FuturescotAdapter(config.get("futurescot_adapter", {})),
        TechcabalAdapter(config.get("techcabal_adapter", {})),
        BenjamindadaAdapter(config.get("benjamindada_adapter", {})),
        TechnextNgAdapter(config.get("technext_ng_adapter", {})),
        TechafricanewsAdapter(config.get("techafricanews_adapter", {})),
        TechtrendskeAdapter(config.get("techtrendske_adapter", {})),
        TechIshAdapter(config.get("tech_ish_adapter", {})),
        TechmoranAdapter(config.get("techmoran_adapter", {})),
        MemeburnAdapter(config.get("memeburn_adapter", {})),
        WeetrackerAdapter(config.get("weetracker_adapter", {})),
        TechweezAdapter(config.get("techweez_adapter", {})),
        VentureburnAdapter(config.get("ventureburn_adapter", {})),
        VenturesafricaAdapter(config.get("venturesafrica_adapter", {})),
        Inc42Adapter(config.get("inc42_adapter", {})),
        EntrackrAdapter(config.get("entrackr_adapter", {})),
        DealstreetasiaAdapter(config.get("dealstreetasia_adapter", {})),
        TechloyAdapter(config.get("techloy_adapter", {})),
        KrAsiaAdapter(config.get("kr_asia_adapter", {})),
        TechnodeAdapter(config.get("technode_adapter", {})),
        TechsauceAdapter(config.get("techsauce_adapter", {})),
        EchelonasiaAdapter(config.get("echelonasia_adapter", {})),
        TechninAsiaAdapter(config.get("technin_asia_adapter", {})),
        VulcanpostAdapter(config.get("vulcanpost_adapter", {})),
        PandailyAdapter(config.get("pandaily_adapter", {})),
        WamdaAdapter(config.get("wamda_adapter", {})),
        MaddynessAdapter(config.get("maddyness_adapter", {})),
        TechfundingasiaAdapter(config.get("techfundingasia_adapter", {})),
        StartupnewsasiaAdapter(config.get("startupnewsasia_adapter", {})),
        VietceteraAdapter(config.get("vietcetera_adapter", {})),
        BloomingstartupAdapter(config.get("bloomingstartup_adapter", {})),
        AfricanbusinessTechAdapter(config.get("africanbusiness_tech_adapter", {})),
        MenabytesAdapter(config.get("menabytes_adapter", {})),
        MagnittAdapter(config.get("magnitt_adapter", {})),
        WadiMenaAdapter(config.get("wadi_mena_adapter", {})),
        StartupbahrainAdapter(config.get("startupbahrain_adapter", {})),
        TechjuiceAdapter(config.get("techjuice_adapter", {})),
        PakwiredAdapter(config.get("pakwired_adapter", {})),
        DailysocialAdapter(config.get("dailysocial_adapter", {})),
        TechstartupsAdapter(config.get("techstartups_adapter", {})),
        StartupnewsmeAdapter(config.get("startupnewsme_adapter", {})),
        MiddleeastventuresAdapter(config.get("middleeastventures_adapter", {})),
        EuropeanstartupsAdapter(config.get("europeanstartups_adapter", {})),
        StartupobserverAdapter(config.get("startupobserver_adapter", {})),
        StartupsavantAdapter(config.get("startupsavant_adapter", {})),
        TechrasaAdapter(config.get("techrasa_adapter", {})),
        TechgistafricaAdapter(config.get("techgistafrica_adapter", {})),
        ItnewsafricaAdapter(config.get("itnewsafrica_adapter", {})),
        DisfoldBlogAdapter(config.get("disfold_blog_adapter", {})),
        StartupradiusAdapter(config.get("startupradius_adapter", {})),
        NextbigwhatAdapter(config.get("nextbigwhat_adapter", {})),
        TechcircleAdapter(config.get("techcircle_adapter", {})),
        SiliconangleStartupsAdapter(config.get("siliconangle_startups_adapter", {})),
        ReadwriteStartupsAdapter(config.get("readwrite_startups_adapter", {})),
        TechinformedAdapter(config.get("techinformed_adapter", {})),
        StartupdailyAfricaAdapter(config.get("startupdaily_africa_adapter", {})),
        TechlabariAdapter(config.get("techlabari_adapter", {})),
        Innov8tivAdapter(config.get("innov8tiv_adapter", {})),
        SmesouthafricaAdapter(config.get("smesouthafrica_adapter", {})),
        TechawkngAdapter(config.get("techawkng_adapter", {})),
        TechnovaghAdapter(config.get("technovagh_adapter", {})),
        AfritechieAdapter(config.get("afritechie_adapter", {})),
        FrenchwebAdapter(config.get("frenchweb_adapter", {})),
        MaddynessFrAdapter(config.get("maddyness_fr_adapter", {})),
        GruenderszeneAdapter(config.get("gruenderszene_adapter", {})),
        SiliconalleeAdapter(config.get("siliconallee_adapter", {})),
        SiftedeuNewsAdapter(config.get("siftedeu_news_adapter", {})),
        ArcticstartupAdapter(config.get("arcticstartup_adapter", {})),
        EuStartupsNewsAdapter(config.get("eu_startups_news_adapter", {})),
        UktechnewsAdapter(config.get("uktechnews_adapter", {})),
        IrishtechnewsAdapter(config.get("irishtechnews_adapter", {})),
        TechplutoAdapter(config.get("techpluto_adapter", {})),
        SiliconrepublicStartupsAdapter(config.get("siliconrepublic_startups_adapter", {})),
        TechforgeMediaAdapter(config.get("techforge_media_adapter", {})),
        SiftedProAdapter(config.get("sifted_pro_adapter", {})),
        FoundersguideAdapter(config.get("foundersguide_adapter", {})),
        StartupvalleyNewsAdapter(config.get("startupvalley_news_adapter", {})),
        TechbehemothsBlogAdapter(config.get("techbehemoths_blog_adapter", {})),
        StartupscootAdapter(config.get("startupscoot_adapter", {})),
        SeedrsInsightsAdapter(config.get("seedrs_insights_adapter", {})),
        EuvcInsightsAdapter(config.get("euvc_insights_adapter", {})),
        StartupmagEuropeAdapter(config.get("startupmag_europe_adapter", {})),
        VatorStartupsAdapter(config.get("vator_startups_adapter", {})),
        StartusInsightsAdapter(config.get("startus_insights_adapter", {})),
        TracxnBlogAdapter(config.get("tracxn_blog_adapter", {})),
        F6sNewsAdapter(config.get("f6s_news_adapter", {})),
        EuvcDealsAdapter(config.get("euvc_deals_adapter", {})),
        VenturecapitaljournalAdapter(config.get("venturecapitaljournal_adapter", {})),
        PrivateequitywireVcAdapter(config.get("privateequitywire_vc_adapter", {})),
        GlobalventuringAdapter(config.get("globalventuring_adapter", {})),
        ThehumancapitalAdapter(config.get("thehumancapital_adapter", {})),
        StartupsatelliteAdapter(config.get("startupsatellite_adapter", {})),
        StartupgeniusAdapter(config.get("startupgenius_adapter", {})),
        FounderjarAdapter(config.get("founderjar_adapter", {})),
        SmallbiztrendsStartupsAdapter(config.get("smallbiztrends_startups_adapter", {})),
        StartupgrindBlogAdapter(config.get("startupgrind_blog_adapter", {})),
        ForentrepreneursAdapter(config.get("forentrepreneurs_adapter", {})),
        BothsidesofthetableAdapter(config.get("bothsidesofthetable_adapter", {})),
        AvcBlogAdapter(config.get("avc_blog_adapter", {})),
        FeldthoughtsAdapter(config.get("feldthoughts_adapter", {})),
        SaastrBlogAdapter(config.get("saastr_blog_adapter", {})),
        TomtunguzAdapter(config.get("tomtunguz_adapter", {})),
        OpenhubstartupAdapter(config.get("openhubstartup_adapter", {})),
        StartuptalkyAdapter(config.get("startuptalky_adapter", {})),
        YourtechtodayAdapter(config.get("yourtechtoday_adapter", {})),
        TechsafarizAdapter(config.get("techsafariz_adapter", {})),
        AfricatechdailyAdapter(config.get("africatechdaily_adapter", {})),
        StartupnewszoneAdapter(config.get("startupnewszone_adapter", {})),
        VenturefoundersAdapter(config.get("venturefounders_adapter", {})),
        NewstartupmediaAdapter(config.get("newstartupmedia_adapter", {})),
        SeedfundnewsAdapter(config.get("seedfundnews_adapter", {})),
        TechpulsefoundersAdapter(config.get("techpulsefounders_adapter", {})),
        StartupreporterAdapter(config.get("startupreporter_adapter", {})),
        FoundersradarAdapter(config.get("foundersradar_adapter", {})),
        DeeptechdigestAdapter(config.get("deeptechdigest_adapter", {})),
        FuturefoundersnewsAdapter(config.get("futurefoundersnews_adapter", {})),
        NextventuredailyAdapter(config.get("nextventuredaily_adapter", {})),
        StartupwireglobalAdapter(config.get("startupwireglobal_adapter", {})),
        FrontierstartupsAdapter(config.get("frontierstartups_adapter", {})),
        ClimatestartupsnewsAdapter(config.get("climatestartupsnews_adapter", {})),
        IndustriousventuresAdapter(config.get("industriousventures_adapter", {})),
        LogisticstechnewsAdapter(config.get("logisticstechnews_adapter", {})),
        AgxstartupnewsAdapter(config.get("agxstartupnews_adapter", {})),
        EnterprisefoundryAdapter(config.get("enterprisefoundry_adapter", {})),
        SeedstageinsiderAdapter(config.get("seedstageinsider_adapter", {})),
        VcsignalsdailyAdapter(config.get("vcsignalsdaily_adapter", {})),
        StartupcurrentsAdapter(config.get("startupcurrents_adapter", {})),
        VenturechronicleAdapter(config.get("venturechronicle_adapter", {})),
        FoundersbriefingAdapter(config.get("foundersbriefing_adapter", {})),
    ]
    collected: list[StartupSignal] = []
    for index, adapter in enumerate(adapters):
        batch = fetch_with_resilience(adapter, logger, retries=retries, backoff_seconds=backoff_seconds)
        collected.extend(batch)
        if delay_seconds > 0 and index < len(adapters) - 1:
            time.sleep(delay_seconds)
    return collected


def run_pipeline(config: dict) -> list[StartupSignal]:
    signals = collect_signals(config)
    signals = filter_excluded(signals, config.get("filters", {}).get("exclude_companies", []))
    signals = filter_by_category(signals, config.get("categories", []))
    signals = filter_by_stage(signals, config.get("stages", []))
    signals = enrich_batch(signals)
    signals = deduplicate_signals(signals)
    return [s.normalize() for s in signals]


def write_csv(signals: list[StartupSignal], output_dir: str) -> str:
    timestamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    os.makedirs(output_dir, exist_ok=True)
    path = f"{output_dir}/startup_watch_{timestamp}.csv"
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow([
            "company_name",
            "website",
            "description",
            "stage",
            "categories",
            "source_name",
            "source_url",
            "scraped_at",
            "founders",
            "linkedin_url",
            "location",
            "funding_amount",
            "investor_names",
            "notes",
            "headcount_range",
            "total_raised",
            "investor_tier",
        ])
        for signal in signals:
            writer.writerow([
                signal.company_name,
                signal.website,
                signal.description,
                signal.stage,
                "|".join(signal.categories),
                signal.source_name,
                signal.source_url,
                signal.scraped_at,
                "|".join(signal.founders),
                signal.linkedin_url,
                signal.location,
                signal.funding_amount,
                "|".join(signal.investor_names),
                signal.notes,
                signal.headcount_range,
                signal.total_raised,
                signal.investor_tier,
            ])
    return path
