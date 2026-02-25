export interface SmartHRConfig {
  baseUrl: string;
  accessToken: string;
}

export interface SmartHRCrew {
  id: string;
  emp_code: string;
  last_name: string;
  first_name: string;
  last_name_yomi: string;
  first_name_yomi: string;
  department?: {
    id: string;
    name: string;
  };
  custom_fields?: Array<{
    custom_field_template_id: string;
    value: string | null;
  }>;
}

export interface SmartHRDepartment {
  id: string;
  name: string;
  parent_id?: string;
}

export interface StaffMasterEntry {
  staffNumber: string;   // emp_code
  staffName: string;     // last_name + first_name (space separated)
  staffNameYomi: string; // last_name_yomi + first_name_yomi (space separated)
  qualifications: string[];
}
