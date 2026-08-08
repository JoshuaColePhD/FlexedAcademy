const frameworks = [
  {id: 'ELA', label: 'English Language Arts (2021)'},
  {id: 'AP_Lang', label: 'AP English Language and Composition'},
  {id: 'Math', label: 'Mathematics (2019)'},
  {id: 'AP_Calc_AB', label: 'AP Calculus AB'},
  {id: 'AP_US_History', label: 'AP United States History'},
  {id: 'Science', label: 'Science (2023)'},
  {id: 'Arts', label: 'Arts Education'},
  {id: 'World_Languages', label: 'World Languages (2017)'}
];

const DISCIPLINE_ORDER = [
  'English / Language Arts',
  'Mathematics',
  'Science',
  'History / Social Studies',
  'World Languages',
  'Arts',
  'PE & Health',
  'Computer Science',
  'Other'
];

function getDiscipline(fw) {
  const text = (fw.id + ' ' + fw.label).toLowerCase();
  
  if (/(english|lang|ela|literature|composition|reading|writing|literacy)/.test(text)) return 'English / Language Arts';
  if (/(math|calculus|algebra|geometry|statistics|precalculus)/.test(text)) return 'Mathematics';
  if (/(science|biology|chemistry|physics|environmental)/.test(text) && !/(computer|political)/.test(text)) return 'Science';
  if (/(history|social studies|government|geography|economics|psychology|macroeconomics|microeconomics)/.test(text)) return 'History / Social Studies';
  if (/(world language|spanish|french|german|latin|chinese|japanese|italian)/.test(text)) return 'World Languages';
  if (/(art|music|theater|drama|drawing)/.test(text) && !/(language arts)/.test(text)) return 'Arts';
  if (/(physical education|health|pe)/.test(text)) return 'PE & Health';
  if (/(computer|digital|programming)/.test(text)) return 'Computer Science';
  
  return 'Other';
}

console.log(frameworks.map(f => `${f.label} -> ${getDiscipline(f)}`));
