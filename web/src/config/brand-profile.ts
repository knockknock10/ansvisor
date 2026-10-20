import type { BusinessModel, ConversionGoal } from '@/types';

export const BUSINESS_MODEL_OPTIONS: { value: BusinessModel; label: string }[] = [
  { value: 'saas', label: 'settings.businessModels.saas' },
  { value: 'e_commerce', label: 'settings.businessModels.e_commerce' },
  { value: 'marketplace', label: 'settings.businessModels.marketplace' },
  { value: 'agency', label: 'settings.businessModels.agency' },
  { value: 'local_business', label: 'settings.businessModels.local_business' },
  { value: 'publisher', label: 'settings.businessModels.publisher' },
  { value: 'nonprofit', label: 'settings.businessModels.nonprofit' },
  { value: 'other', label: 'settings.businessModels.other' },
];

export const CONVERSION_GOAL_OPTIONS: { value: ConversionGoal; label: string }[] = [
  { value: 'sign_up', label: 'settings.conversionGoalOptions.sign_up' },
  { value: 'demo_request', label: 'settings.conversionGoalOptions.demo_request' },
  { value: 'purchase', label: 'settings.conversionGoalOptions.purchase' },
  { value: 'lead_form', label: 'settings.conversionGoalOptions.lead_form' },
  { value: 'contact', label: 'settings.conversionGoalOptions.contact' },
  { value: 'subscribe', label: 'settings.conversionGoalOptions.subscribe' },
  { value: 'book_appointment', label: 'settings.conversionGoalOptions.book_appointment' },
  { value: 'other', label: 'settings.conversionGoalOptions.other' },
];

export const BUSINESS_MODEL_VALUES = BUSINESS_MODEL_OPTIONS.map((option) => option.value);
export const CONVERSION_GOAL_VALUES = CONVERSION_GOAL_OPTIONS.map((option) => option.value);
