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
  business_last_name?: string;
  business_first_name?: string;
  gender?: string;            // "male" | "female" | null
  entered_at?: string;
  resigned_at?: string;
  employment_type?: {
    name: string;
  };
  department?: {
    id: string;
    name: string;
  };
  departments?: SmartHRDepartment[];
  positions?: Array<{ name: string }>;
  grade?: { name: string };
  job_category?: { name: string };
  custom_fields?: Array<{
    value: string | null;
    template: {
      id: string;
      name: string;
      type: string;
      elements?: Array<{
        physical_name: string;
        name: string;
      }> | null;
    };
  }>;
}

export interface SmartHRDepartment {
  id: string;
  name: string;
  full_name?: string;
  parent_id?: string;
  parent?: SmartHRDepartment;
}

export interface StaffMasterEntry {
  staffNumber: string;        // emp_code
  staffName: string;          // ビジネスネーム or 氏名
  staffNameLegal: string;     // 戸籍上の氏名
  staffNameYomi: string;      // フリガナ
  gender: string;             // "male" | "female" | ""
  qualifications: string[];   // 資格1〜8
  departmentName: string;     // 部署名
  enteredAt: string;          // 入社日
  resignedAt: string;         // 退職日
}
