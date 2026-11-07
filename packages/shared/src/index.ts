// Спільні типи API. Згенеровані з OpenAPI-схеми FastAPI (`npm run gen:types`),
// тому вручну тут нічого не пишемо: джерело істини — Pydantic-моделі в apps/api.
import type { components } from "./api.gen";

export type { components, operations, paths } from "./api.gen";

type Schemas = components["schemas"];

export type HealthResponse = Schemas["HealthResponse"];
export type ReadinessResponse = Schemas["ReadinessResponse"];

export type FlightQuery = Schemas["FlightQuery"];
export type Passengers = Schemas["Passengers"];
export type Offer = Schemas["Offer"];
export type Leg = Schemas["Leg"];
export type Segment = Schemas["Segment"];
export type Layover = Schemas["Layover"];
export type ProviderStatus = Schemas["ProviderStatus"];
export type FlightSearchResult = Schemas["FlightSearchResult"];
export type CalendarDay = Schemas["CalendarDay"];
export type CalendarResult = Schemas["CalendarResult"];
export type Profile = FlightQuery["profile"];
export type ScoringResult = Schemas["ScoringResult"];
export type OfferScore = Schemas["OfferScore"];
export type ScoreBreakdown = Schemas["ScoreBreakdown"];
export type RiskPenalty = Schemas["RiskPenalty"];
export type ScoreWarning = Schemas["ScoreWarning"];
export type Pick = Schemas["Pick"];
export type PickLabel = Pick["label"];
export type Place = Schemas["Place"];
export type OfferFilters = Schemas["OfferFilters"];
export type DeparturePeriod = NonNullable<
  OfferFilters["departure_periods"]
>[number];
export type SearchFacets = Schemas["SearchFacets"];
export type AirlineFacet = Schemas["AirlineFacet"];
export type AIStatus = Schemas["AIStatus"];
export type ParseRequest = Schemas["ParseRequest"];
export type ParseResult = Schemas["ParseResult"];
export type ParseNote = NonNullable<ParseResult["notes"]>[number];
export type ChatTurn = Schemas["ChatTurn"];
export type ChatBody = Schemas["ChatBody"];
export type ChatReply = Schemas["ChatReply"];
export type ExplainResult = Schemas["ExplainResult"];
export type Explanation = Schemas["Explanation"];
export type ChatMode = NonNullable<ChatBody["mode"]>;
export type StayQuery = Schemas["StayQuery"];
export type StayFilters = Schemas["StayFilters"];
export type StayProfile = NonNullable<StayQuery["profile"]>;
export type StayKind = Schemas["Stay"]["kind"];
export type Stay = Schemas["Stay"];
export type StaySearchResult = Schemas["StaySearchResult"];
export type StayScoringResult = Schemas["StayScoringResult"];
export type StayScore = Schemas["StayScore"];
export type StayPick = Schemas["StayPick"];
export type StayPickLabel = StayPick["label"];
export type StayFacets = Schemas["StayFacets"];
export type StayAnalysisResult = Schemas["StayAnalysisResult"];
export type StayAnalysis = Schemas["StayAnalysis"];
export type StayInsight = Schemas["StayInsight"];
export type TripQuery = Schemas["TripQuery"];
export type TripProfile = NonNullable<TripQuery["profile"]>;
export type TripSearchResult = Schemas["TripSearchResult"];
export type TripCombo = Schemas["TripCombo"];
export type TripPick = Schemas["TripPick"];
export type TripPickLabel = TripPick["label"];
export type TripWarning = NonNullable<TripCombo["warnings"]>[number];
export type AlertCreate = Schemas["AlertCreate"];
export type AlertCreated = Schemas["AlertCreated"];
export type AlertView = Schemas["AlertView"];
export type AlertChannel = AlertView["channel"];
export type AlertCondition = AlertView["condition"];
export type ChannelStatus = Schemas["ChannelStatus"];
export type Account = Schemas["Account"];
export type AccountAlert = Schemas["AccountAlert"];
export type AuthStatus = Schemas["AuthStatus"];
export type SessionOut = Schemas["SessionOut"];
export type SearchEntry = Schemas["SearchEntryOut"];
export type SearchKind = SearchEntry["kind"];
export type ClickIn = Schemas["ClickIn"];
